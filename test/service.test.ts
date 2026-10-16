import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalisePhone } from "../src/phone.js";
import { SandboxProvider } from "../src/providers/sandbox.js";
import { createApp } from "../src/server.js";
import { Payments } from "../src/service.js";
import { canMove } from "../src/state.js";
import { postgresStore, sqliteStore, type Store } from "../src/store.js";
import { type Payment, type Provider, ProviderUnreachable, type ProviderResult } from "../src/types.js";
import { Clock, fakeServer } from "./helpers.js";

const KEY = "test-key";
const OWNER = createHash("sha256").update(KEY).digest("hex").slice(0, 16); // how the API scopes data to a key
const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const collection = (phone: string, extra: object = {}) =>
  JSON.stringify({ amount: 2500, currency: "GHS", phone, network: "mtn", customer: { email: "ama@example.com" }, description: "Order 42", ...extra });

function setup(store: Store = sqliteStore(), extraProviders: Provider[] = [], webhook?: { url: string; secret: string }) {
  const clock = new Clock();
  const sandbox = new SandboxProvider(3000, clock.now);
  const payments = new Payments(store, [sandbox, ...extraProviders], { mtn: "sandbox", telecel: "sandbox", airteltigo: "sandbox", mpesa: "sandbox" }, webhook, clock.now);
  const app = createApp({ payments, store, apiKeys: [KEY] });
  let n = 0;
  const post = (path: string, body: string, key = `k${++n}`) => app.request(path, { method: "POST", headers: { ...H, "idempotency-key": key }, body });
  const get = (path: string) => app.request(path, { headers: H });
  return { app, clock, payments, store, post, get };
}

describe("phones and states", () => {
  it("normalises Ghana and Kenya numbers", () => {
    expect(normalisePhone("024 123 4567", "mtn")).toBe("233241234567");
    expect(normalisePhone("+233-20-123-4567", "telecel")).toBe("233201234567");
    expect(normalisePhone("0712345678", "mpesa")).toBe("254712345678");
    expect(normalisePhone("0712345678", "mtn")).toBe("233712345678"); // shape-valid; the network decides the country
    expect(normalisePhone("12345", "mtn")).toBeNull();
    expect(normalisePhone("0024123456", "mtn")).toBeNull();
  });
  it("only allows the documented moves", () => {
    expect(canMove("pending", "succeeded")).toBe(true);
    expect(canMove("succeeded", "reversed")).toBe(true);
    expect(canMove("failed", "succeeded")).toBe(false);
    expect(canMove("succeeded", "failed")).toBe(false);
    expect(canMove("reversed", "pending")).toBe(false);
  });
});

describe("collections and payouts through the sandbox", () => {
  it("creates a pending collection, then succeeds", async () => {
    const t = setup();
    const res = await t.post("/v1/collections", collection("0241234567"));
    expect(res.status).toBe(201);
    const p: Payment = await res.json();
    expect(p).toMatchObject({ status: "pending", phone: "233241234567", provider: "sandbox", amount: 2500, currency: "GHS" });
    expect(p.reference).toMatch(/^[0-9a-f-]{36}$/);

    t.clock.advance(3000);
    const after: Payment = await (await t.app.request(`/v1/payments/${p.id}/refresh`, { method: "POST", headers: H })).json();
    expect(after.status).toBe("succeeded");
    expect(after.completed_at).not.toBeNull();
    const events = (await (await t.get(`/v1/payments/${p.id}/events`)).json()).events.map((e: { type: string }) => e.type);
    expect(events).toEqual(["payment.pending", "payment.succeeded"]);
  });

  it.each([
    ["0240000001", "declined"],
    ["0240000002", "insufficient_funds"],
  ])("normalises failures (%s -> %s)", async (phone, code) => {
    const t = setup();
    const p: Payment = await (await t.post("/v1/collections", collection(phone))).json();
    t.clock.advance(3000);
    const after = await t.payments.refresh(OWNER, p.id);
    expect(after.status).toBe("failed");
    expect(after.failure?.code).toBe(code);
  });

  it("handles OTPs", async () => {
    const t = setup();
    const p: Payment = await (await t.post("/v1/collections", collection("0240000004"))).json();
    expect(p.status).toBe("action_required");
    expect(p.action?.type).toBe("otp");
    const wrong = await t.app.request(`/v1/payments/${p.id}/otp`, { method: "POST", headers: H, body: JSON.stringify({ otp: "000000" }) });
    expect((await wrong.json()).status).toBe("action_required");
    const right = await t.app.request(`/v1/payments/${p.id}/otp`, { method: "POST", headers: H, body: JSON.stringify({ otp: "123456" }) });
    expect((await right.json()).status).toBe("succeeded");
  });

  it("records a payout that is reversed after succeeding", async () => {
    const t = setup();
    const res = await t.post("/v1/payouts", JSON.stringify({ amount: 10000, currency: "GHS", phone: "0240000005", network: "telecel", customer: { name: "Kofi Boateng" } }));
    const p: Payment = await res.json();
    t.clock.advance(3000);
    expect((await t.payments.refresh(OWNER, p.id)).status).toBe("succeeded");
    t.clock.advance(3000);
    expect((await t.payments.refresh(OWNER, p.id)).status).toBe("reversed");
  });

  it("needs a name for payouts and an Idempotency-Key for everything", async () => {
    const t = setup();
    expect((await t.post("/v1/payouts", JSON.stringify({ amount: 100, currency: "GHS", phone: "0241234567", network: "mtn" }))).status).toBe(400);
    expect((await t.app.request("/v1/collections", { method: "POST", headers: H, body: collection("0241234567") })).status).toBe(400);
  });

  it("rejects bad input clearly", async () => {
    const t = setup();
    const bad = await t.post("/v1/collections", JSON.stringify({ amount: 25.5, currency: "NGN", phone: "x", network: "glo" }));
    expect(bad.status).toBe(400);
    const issues = (await bad.json()).issues.map((i: { path: string }) => i.path).sort();
    expect(issues).toEqual(["amount", "currency", "network", "phone"]);
    const phone = await t.post("/v1/collections", collection("0241 2345")); // passes the schema, too short for Ghana
    expect(phone.status).toBe(400);
    expect((await phone.json()).error).toMatch(/Ghanaian/);
  });

  it("never creates a second payment for a retried request", async () => {
    const t = setup();
    const a = await t.post("/v1/collections", collection("0241234567"), "order-42");
    const b = await t.post("/v1/collections", collection("0241234567"), "order-42");
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect((await b.json()).id).toBe((await a.json()).id);
    const c = await t.post("/v1/collections", collection("0241234567", { amount: 9999 }), "order-42");
    expect(c.status).toBe(409);
  });

  it("keeps payments private to the API key that made them", async () => {
    const t = setup();
    const p: Payment = await (await t.post("/v1/collections", collection("0241234567"))).json();
    const other = createApp({ payments: t.payments, store: t.store, apiKeys: ["other"] });
    expect((await other.request(`/v1/payments/${p.id}`, { headers: { authorization: "Bearer other" } })).status).toBe(404);
    expect((await t.app.request(`/v1/payments/${p.id}`)).status).toBe(401);
  });
});

describe("when the provider is unreachable", () => {
  it("stays pending and the reconciler finds out later", async () => {
    let up = false;
    const flaky: Provider = {
      name: "flaky",
      supports: () => true,
      collect: async () => {
        throw new ProviderUnreachable("timeout");
      },
      payout: async () => ({ status: "pending", providerStatus: "x" }),
      status: async (): Promise<ProviderResult> => {
        if (!up) throw new ProviderUnreachable("still down");
        return { status: "succeeded", providerStatus: "SUCCESSFUL", providerReference: "FT123" };
      },
    };
    const t = setup(sqliteStore(), [flaky]);
    const p: Payment = await (await t.post("/v1/collections", collection("0241234567", { provider: "flaky" }))).json();
    expect(p.status).toBe("pending");
    expect(p.provider_status).toBe("unknown_after_error");

    t.clock.advance(15_000);
    await t.payments.runDue();
    expect((await t.store.get(p.id))!.payment.status).toBe("pending");

    up = true;
    t.clock.advance(60_000);
    await t.payments.runDue();
    const after = (await t.store.get(p.id))!.payment;
    expect(after.status).toBe("succeeded");
    expect(after.provider_reference).toBe("FT123");
  });
});

describe("reconciliation", () => {
  it("flags a provider that changes its mind instead of overwriting", async () => {
    let says: ProviderResult = { status: "failed", providerStatus: "FAILED", failure: { code: "declined", message: "no" } };
    const fickle: Provider = { name: "fickle", supports: () => true, collect: async () => says, payout: async () => says, status: async () => says };
    const t = setup(sqliteStore(), [fickle]);
    const p: Payment = await (await t.post("/v1/collections", collection("0241234567", { provider: "fickle" }))).json();
    expect(p.status).toBe("failed");

    says = { status: "succeeded", providerStatus: "SUCCESSFUL" };
    const r1 = await t.payments.reconcile(24);
    const r2 = await t.payments.reconcile(24);
    expect(r1).toMatchObject({ checked: 1, mismatched: 1 });
    expect(r2.mismatched).toBe(1);
    const stored = (await t.store.get(p.id))!.payment as Payment & { mismatch?: { provider_says: string } };
    expect(stored.status).toBe("failed"); // not silently changed
    expect(stored.mismatch?.provider_says).toBe("succeeded");
    const types = (await t.store.events(OWNER, p.id)).map((e) => e.type);
    expect(types.filter((x) => x === "payment.mismatch")).toHaveLength(1); // reported once, not on every run

    const report = await (await t.get("/v1/reconciliation")).json();
    expect(report.mismatches).toHaveLength(1);
  });

  it("lists payments stuck pending for over an hour", async () => {
    const t = setup();
    await t.post("/v1/collections", collection("0240000003"));
    t.clock.advance(61 * 60_000);
    const report = await (await t.get("/v1/reconciliation")).json();
    expect(report.stuck).toHaveLength(1);
    expect(report.counts.pending).toBe(1);
  });
});

describe("outgoing webhooks", () => {
  let hook: Awaited<ReturnType<typeof fakeServer>>;
  let fail = 0;
  beforeEach(async () => {
    fail = 1;
    hook = await fakeServer(() => (fail-- > 0 ? { status: 500 } : { status: 200 }));
  });
  afterEach(() => hook.close());

  it("signs like Webhook Relay's generic source and retries", async () => {
    const t = setup(sqliteStore(), [], { url: hook.url, secret: "whsec" });
    await t.post("/v1/collections", collection("0241234567"));
    await t.payments.deliverDue();
    expect(hook.seen).toHaveLength(1); // got a 500
    t.clock.advance(10_000);
    await t.payments.deliverDue();
    expect(hook.seen).toHaveLength(2);
    const last = hook.seen[1]!;
    const raw = JSON.stringify(last.body);
    expect(last.headers["x-signature"]).toBe("sha256=" + createHmac("sha256", "whsec").update(raw).digest("hex"));
    expect(last.headers["x-webhook-id"]).toBe(last.body.id);
    expect(last.body.type).toBe("payment.pending");
    t.clock.advance(60_000);
    expect(await t.payments.deliverDue()).toBe(0); // delivered; nothing left
  });
});

describe.runIf(process.env.TEST_DATABASE_URL)("on Postgres", () => {
  it("creates, replays and updates payments", async () => {
    const store = await postgresStore(process.env.TEST_DATABASE_URL!);
    const t = setup(store);
    const key = "pg-" + Date.now();
    const a: Payment = await (await t.post("/v1/collections", collection("0241234567"), key)).json();
    const b: Payment = await (await t.post("/v1/collections", collection("0241234567"), key)).json();
    expect(b.id).toBe(a.id);
    t.clock.advance(3000);
    expect((await t.payments.refresh(OWNER, a.id)).status).toBe("succeeded");
    await store.close();
  });
});

vi.setConfig({ testTimeout: 10_000 });
