import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { normalisePhone } from "./phone.js";
import { canMove, isOpen } from "./state.js";
import { newId, type OutEvent, type PaymentRow, type Store } from "./store.js";
import { CURRENCIES, NETWORKS, type Direction, type Network, type Payment, type Provider, ProviderRejected, type ProviderResult, type Status } from "./types.js";

const Meta = z.record(z.string().max(40), z.string().max(500)).refine((m) => Object.keys(m).length <= 20, "At most 20 metadata keys");

const Base = z.object({
  amount: z.number().int("amount is in minor units (pesewas or cents), e.g. GHS 10.50 is 1050").positive().max(100_000_000),
  currency: z.enum(CURRENCIES),
  phone: z.string().min(9).max(20),
  network: z.enum(NETWORKS),
  provider: z.string().optional(),
  description: z.string().max(100).optional(),
  metadata: Meta.default({}),
});
export const CollectionInput = Base.extend({ customer: z.object({ email: z.email().optional(), name: z.string().max(100).optional() }).default({}) });
export const PayoutInput = Base.extend({ customer: z.object({ name: z.string().min(1).max(100), email: z.email().optional() }) });

export class ApiError extends Error {
  constructor(public status: 400 | 404 | 409 | 422, message: string) {
    super(message);
  }
}

export type WebhookTarget = { url: string; secret: string };

// After each status check, wait this long before the next (then every 15 minutes).
const CHECK_DELAYS = [15, 30, 60, 120, 300, 600].map((s) => s * 1000);
const STUCK_AFTER_MS = 60 * 60 * 1000;
// Webhook retries: 10 s, 30 s, 2 m, 10 m, 30 m, then hourly, up to 12 attempts.
const EVENT_DELAYS = [10, 30, 120, 600, 1800].map((s) => s * 1000);
const MAX_EVENT_ATTEMPTS = 12;

export class Payments {
  private providers = new Map<string, Provider>();
  constructor(
    private store: Store,
    providers: Provider[],
    private routes: Partial<Record<Network, string>>,
    private webhook?: WebhookTarget,
    private now: () => number = Date.now,
  ) {
    for (const p of providers) this.providers.set(p.name, p);
  }

  /** Which provider handles which network, as configured. */
  routing() {
    return {
      providers: [...this.providers.keys()],
      routes: Object.fromEntries(NETWORKS.map((n) => [n, this.routes[n] ?? null])),
    };
  }

  async create(owner: string, direction: Direction, idempotencyKey: string, rawBody: string) {
    const input = (direction === "collection" ? CollectionInput : PayoutInput).parse(JSON.parse(rawBody));
    const phone = normalisePhone(input.phone, input.network);
    if (!phone) throw new ApiError(400, `phone doesn't look like a ${input.network === "mpesa" ? "Kenyan" : "Ghanaian"} mobile number`);
    const provider = this.pick(direction, input.network, input.currency, input.provider);

    const ts = new Date(this.now()).toISOString();
    const payment: Payment = {
      id: newId("pay"),
      direction,
      status: "pending",
      amount: input.amount,
      currency: input.currency,
      phone,
      network: input.network,
      provider: provider.name,
      reference: randomUUID(), // ours, so the provider can always be asked about it
      provider_reference: null,
      provider_status: null,
      failure: null,
      action: null,
      customer: input.customer,
      description: input.description ?? null,
      metadata: input.metadata,
      created_at: ts,
      updated_at: ts,
      completed_at: null,
    };
    const hash = createHash("sha256").update(rawBody).digest("hex");

    // Record first, then call the provider. If we crash in between, the reconciler still
    // has the reference and will ask the provider what happened.
    const { row, created } = await this.store.createPayment({ payment, owner, idempotency_key: idempotencyKey, request_hash: hash, next_check_at: this.now() + CHECK_DELAYS[0]!, checks: 0 });
    if (!created) {
      if (row.request_hash !== hash) throw new ApiError(409, "This Idempotency-Key was already used with a different request");
      return { payment: row.payment, replayed: true };
    }
    await this.emit(row, "payment.pending");

    let result: ProviderResult;
    try {
      result = direction === "collection" ? await provider.collect(payment) : await provider.payout(payment);
    } catch (err) {
      if (err instanceof ProviderRejected) {
        result = { status: "failed", providerStatus: "rejected", failure: { code: err.code, message: err.message } };
      } else {
        // Timeout or connection error: we don't know if it reached the provider. Stay pending; the reconciler will find out.
        result = { status: "pending", providerStatus: "unknown_after_error" };
      }
    }
    return { payment: await this.apply(row, result), replayed: false };
  }

  async get(owner: string, id: string) {
    const row = await this.store.get(id);
    if (!row || row.owner !== owner) throw new ApiError(404, "Payment not found");
    return row;
  }

  /** Ask the provider now instead of waiting for the next scheduled check. */
  async refresh(owner: string, id: string) {
    const row = await this.get(owner, id);
    return this.check(row);
  }

  async submitOtp(owner: string, id: string, otp: string) {
    const row = await this.get(owner, id);
    if (row.payment.status !== "action_required" || row.payment.action?.type !== "otp") throw new ApiError(409, "This payment isn't waiting for an OTP");
    const provider = this.providers.get(row.payment.provider);
    if (!provider?.submitOtp) throw new ApiError(422, "This provider doesn't take OTPs through the API");
    try {
      return await this.apply(row, await provider.submitOtp(row.payment, otp));
    } catch (err) {
      if (err instanceof ProviderRejected) throw new ApiError(422, err.message);
      throw err;
    }
  }

  /** A provider told us something happened. Never trust the callback body: ask the provider. */
  async notify(provider: string, lookup: { id?: string; reference?: string }) {
    const row = lookup.id ? await this.store.get(lookup.id) : lookup.reference ? await this.store.byReference(provider, lookup.reference) : undefined;
    if (!row || row.payment.provider !== provider) return null;
    return this.check(row);
  }

  /** Status checks that are due. Run on a timer. */
  async runDue(limit = 50) {
    const rows = await this.store.due(this.now(), limit);
    for (const row of rows) await this.check(row).catch(() => undefined);
    return rows.length;
  }

  /**
   * Re-check finished payments against the provider (e.g. once a day). Anything the provider
   * now reports differently is recorded as a mismatch and a payment.mismatch event, and never
   * silently overwritten.
   */
  async reconcile(sinceHours = 24, limit = 1000) {
    const since = new Date(this.now() - sinceHours * 3600_000).toISOString();
    const rows = await this.store.completedSince(since, limit);
    let checked = 0, changed = 0, mismatched = 0;
    for (const row of rows) {
      const before = row.payment.status;
      const after = await this.check(row).catch(() => null);
      if (!after) continue;
      checked++;
      if (after.status !== before) changed++;
      if ((after as Payment & { mismatch?: unknown }).mismatch) mismatched++;
    }
    return { since, checked, changed, mismatched };
  }

  async report(owner: string) {
    const all = await this.store.list(owner, { limit: 10_000 });
    const counts: Record<string, number> = {};
    for (const p of all) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const stuck = all.filter((p) => isOpen(p.status) && this.now() - Date.parse(p.created_at) > STUCK_AFTER_MS);
    const mismatches = all.filter((p) => (p as Payment & { mismatch?: unknown }).mismatch);
    return { counts, stuck, mismatches };
  }

  // --- internals ---------------------------------------------------------------

  private pick(direction: Direction, network: Network, currency: Payment["currency"], requested?: string): Provider {
    const name = requested ?? this.routes[network];
    const p = name ? this.providers.get(name) : undefined;
    if (!p) throw new ApiError(422, requested ? `Provider "${requested}" isn't configured` : `No provider is configured for ${network}`);
    if (!p.supports(direction, network, currency)) throw new ApiError(422, `${p.name} can't do a ${direction} on ${network} in ${currency}`);
    return p;
  }

  private async check(row: PaymentRow): Promise<Payment> {
    const provider = this.providers.get(row.payment.provider);
    if (!provider) return row.payment;
    let result: ProviderResult;
    try {
      result = await provider.status(row.payment);
    } catch {
      // Provider unreachable: try again later, nothing changes.
      row.checks++;
      row.next_check_at = isOpen(row.payment.status) ? this.now() + this.delay(row.checks) : row.next_check_at;
      await this.store.update(row, row.payment.status);
      return row.payment;
    }
    return this.apply(row, result);
  }

  /** Move a payment to what the provider says, if the state machine allows it. */
  private async apply(row: PaymentRow, r: ProviderResult): Promise<Payment> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const p: Payment & { mismatch?: unknown } = { ...row.payment };
      const from = p.status;
      const ts = new Date(this.now()).toISOString();
      let event: string | null = null;

      p.provider_status = r.providerStatus;
      if (r.providerReference) p.provider_reference = r.providerReference;
      if (r.status === from) {
        if (r.action) p.action = r.action;
      } else if (canMove(from, r.status)) {
        p.status = r.status;
        p.failure = r.status === "failed" ? (r.failure ?? { code: "unknown", message: "Failed" }) : null;
        p.action = r.status === "action_required" ? (r.action ?? null) : null;
        if (!isOpen(r.status)) p.completed_at = ts;
        event = `payment.${r.status}`;
      } else {
        // e.g. we recorded "failed" and the provider now says "succeeded". A person needs to look.
        const seen = (p.mismatch as { provider_says?: string } | undefined)?.provider_says === r.status;
        p.mismatch = { provider_says: r.status, provider_status: r.providerStatus, seen_at: ts };
        if (!seen) event = "payment.mismatch"; // tell the merchant once, not on every check
      }
      p.updated_at = ts;
      const next: PaymentRow = {
        ...row,
        payment: p,
        checks: row.checks + 1,
        next_check_at: isOpen(p.status) ? this.now() + this.delay(row.checks + 1) : null,
      };
      if (await this.store.update(next, from)) {
        if (event) await this.emit(next, event);
        return p;
      }
      // Someone else (a webhook, the reconciler) changed it first. Reload and try again.
      const fresh = await this.store.get(row.payment.id);
      if (!fresh) return row.payment;
      row = fresh;
    }
    return row.payment;
  }

  private delay(checks: number) {
    return CHECK_DELAYS[Math.min(checks, CHECK_DELAYS.length - 1)] ?? 900_000;
  }

  private async emit(row: PaymentRow, type: string) {
    const id = newId("evt");
    const created_at = new Date(this.now()).toISOString();
    const body = JSON.stringify({ id, type, created_at, data: row.payment });
    await this.store.addEvent({
      id,
      owner: row.owner,
      payment_id: row.payment.id,
      type,
      created_at,
      body,
      attempts: 0,
      next_attempt_at: this.webhook ? this.now() : null,
      delivered_at: null,
      last_error: null,
    });
  }

  /**
   * Deliver due webhook events. Signed the way Webhook Relay's "generic" source checks:
   * X-Signature: sha256=hex(HMAC-SHA256(secret, body)), with X-Webhook-Id for de-duplication.
   */
  async deliverDue(limit = 50) {
    if (!this.webhook) return 0;
    const events = await this.store.dueEvents(this.now(), limit);
    for (const e of events) await this.deliver(e);
    return events.length;
  }

  private async deliver(e: OutEvent) {
    const { url, secret } = this.webhook!;
    e.attempts++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "momo-one-api",
          "X-Webhook-Id": e.id,
          "X-MoMo-One-Event": e.type,
          "X-Signature": "sha256=" + createHmac("sha256", secret).update(e.body).digest("hex"),
        },
        body: e.body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        e.delivered_at = new Date(this.now()).toISOString();
        e.next_attempt_at = null;
        e.last_error = null;
      } else {
        this.retryLater(e, `HTTP ${res.status}`);
      }
    } catch (err) {
      this.retryLater(e, (err as Error).message);
    }
    await this.store.saveEvent(e);
  }

  private retryLater(e: OutEvent, error: string) {
    e.last_error = error;
    e.next_attempt_at = e.attempts >= MAX_EVENT_ATTEMPTS ? null : this.now() + (EVENT_DELAYS[e.attempts - 1] ?? 3600_000);
  }
}

export type { Status };
