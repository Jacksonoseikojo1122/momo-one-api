import { type Currency, type Direction, type FailureCode, type Network, type Payment, type Provider, ProviderRejected, type ProviderResult, ProviderUnreachable } from "../types.js";
import { ageMs, call, major } from "./http.js";

// MTN MoMo Open API (momodeveloper.mtn.com): Collection "RequesttoPay" and Disbursement "Transfer".
// Every call needs an Ocp-Apim-Subscription-Key, a Bearer token from POST /{product}/token/
// (Basic auth with the API user and key), and X-Target-Environment. We create the
// X-Reference-Id (a UUID), so a payment can always be looked up even if our request timed out.

type Product = "collection" | "disbursement";
type Creds = { userId: string; apiKey: string; subscriptionKey: string };

export type MtnConfig = {
  baseUrl: string; // https://sandbox.momodeveloper.mtn.com in the sandbox
  targetEnvironment: string; // "sandbox", or the value MTN gives you for production
  callbackUrl?: string;
  collection?: Creds;
  disbursement?: Creds;
  currencies?: Currency[]; // the sandbox only accepts EUR
};

const REASONS: Record<string, FailureCode> = {
  APPROVAL_REJECTED: "declined",
  PAYMENT_NOT_APPROVED: "declined",
  TRANSACTION_CANCELED: "declined",
  NOT_ENOUGH_FUNDS: "insufficient_funds",
  EXPIRED: "expired",
  PAYER_NOT_FOUND: "account_not_found",
  PAYEE_NOT_FOUND: "account_not_found",
  PAYER_LIMIT_REACHED: "limit_reached",
  NOT_ALLOWED: "not_allowed",
  NOT_ALLOWED_TARGET_ENVIRONMENT: "not_allowed",
  PAYEE_NOT_ALLOWED_TO_RECEIVE: "not_allowed",
  INVALID_CURRENCY: "not_allowed",
  SERVICE_UNAVAILABLE: "provider_error",
  INTERNAL_PROCESSING_ERROR: "provider_error",
};

export class MtnMomoProvider implements Provider {
  readonly name = "mtn_momo";
  private tokens = new Map<Product, { token: string; expires: number }>();
  constructor(private cfg: MtnConfig) {}

  supports(direction: Direction, network: Network, currency: Currency) {
    const product = direction === "collection" ? this.cfg.collection : this.cfg.disbursement;
    return network === "mtn" && !!product && (this.cfg.currencies ?? ["GHS"]).includes(currency);
  }

  async collect(p: Payment) {
    return this.create("collection", "/v1_0/requesttopay", p, {
      amount: major(p.amount),
      currency: p.currency,
      externalId: p.id,
      payer: { partyIdType: "MSISDN", partyId: p.phone },
      payerMessage: p.description ?? "Payment",
      payeeNote: p.description ?? "Payment",
    });
  }

  async payout(p: Payment) {
    return this.create("disbursement", "/v1_0/transfer", p, {
      amount: major(p.amount),
      currency: p.currency,
      externalId: p.id,
      payee: { partyIdType: "MSISDN", partyId: p.phone },
      payerMessage: p.description ?? "Payout",
      payeeNote: p.description ?? "Payout",
    });
  }

  async status(p: Payment): Promise<ProviderResult> {
    const product: Product = p.direction === "collection" ? "collection" : "disbursement";
    const path = product === "collection" ? "/v1_0/requesttopay/" : "/v1_0/transfer/";
    const res = await call(this.url(product, path + p.reference), { method: "GET", headers: await this.headers(product) });
    if (res.status === 404) {
      // MTN never received it (our create call must have failed before reaching them).
      // Give it two minutes in case of delay, then call it failed: no money can have moved.
      if (ageMs(p.created_at) < 120_000) return { status: "pending", providerStatus: "NOT_FOUND_YET" };
      return { status: "failed", providerStatus: "RESOURCE_NOT_FOUND", failure: { code: "provider_error", message: "MTN has no record of this request." } };
    }
    if (res.status >= 500 || !res.body) throw new ProviderUnreachable(`MTN status check returned HTTP ${res.status}`);
    return mapResult(res.body);
  }

  private async create(product: Product, path: string, p: Payment, body: object): Promise<ProviderResult> {
    const headers = await this.headers(product);
    headers["X-Reference-Id"] = p.reference;
    headers["Content-Type"] = "application/json";
    if (this.cfg.callbackUrl) headers["X-Callback-Url"] = this.cfg.callbackUrl;
    const res = await call(this.url(product, path), { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 202) return { status: "pending", providerStatus: "PENDING" };
    // 409 RESOURCE_ALREADY_EXIST: an earlier attempt with this reference got through. Its status will tell us.
    if (res.status === 409 && res.body?.code === "RESOURCE_ALREADY_EXIST") return { status: "pending", providerStatus: "PENDING" };
    if (res.status >= 500) throw new ProviderUnreachable(`MTN returned HTTP ${res.status}`);
    const code = res.body?.code as string | undefined;
    throw new ProviderRejected(res.body?.message || `MTN refused the request (HTTP ${res.status}${code ? ", " + code : ""})`, (code && REASONS[code]) || "provider_error");
  }

  private async headers(product: Product): Promise<Record<string, string>> {
    const creds = this.creds(product);
    return {
      Authorization: `Bearer ${await this.token(product)}`,
      "X-Target-Environment": this.cfg.targetEnvironment,
      "Ocp-Apim-Subscription-Key": creds.subscriptionKey,
    };
  }

  private async token(product: Product): Promise<string> {
    const cached = this.tokens.get(product);
    if (cached && cached.expires > Date.now()) return cached.token;
    const creds = this.creds(product);
    const res = await call(this.url(product, "/token/"), {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${creds.userId}:${creds.apiKey}`).toString("base64"),
        "Ocp-Apim-Subscription-Key": creds.subscriptionKey,
      },
    });
    if (res.status !== 200 || !res.body?.access_token) {
      if (res.status >= 500) throw new ProviderUnreachable(`MTN token endpoint returned HTTP ${res.status}`);
      throw new ProviderRejected(`MTN didn't issue a token (HTTP ${res.status}). Check the API user, key and subscription key.`, "not_allowed");
    }
    const ttl = Number(res.body.expires_in) || 3600;
    this.tokens.set(product, { token: res.body.access_token, expires: Date.now() + (ttl - 60) * 1000 });
    return res.body.access_token;
  }

  private creds(product: Product): Creds {
    const c = product === "collection" ? this.cfg.collection : this.cfg.disbursement;
    if (!c) throw new ProviderRejected(`MTN ${product} isn't configured`, "not_allowed");
    return c;
  }

  private url(product: Product, path: string) {
    return `${this.cfg.baseUrl.replace(/\/$/, "")}/${product}${path}`;
  }
}

/** RequestToPayResult / TransferResult -> our result. */
export function mapResult(r: any): ProviderResult {
  switch (r.status) {
    case "SUCCESSFUL":
      return { status: "succeeded", providerStatus: "SUCCESSFUL", providerReference: r.financialTransactionId ?? null };
    case "FAILED": {
      const code = r.reason?.code ?? (typeof r.reason === "string" ? r.reason : undefined);
      return {
        status: "failed",
        providerStatus: "FAILED" + (code ? `:${code}` : ""),
        failure: { code: (code && REASONS[code]) || "unknown", message: r.reason?.message || code || "MTN reported the payment as failed." },
      };
    }
    default:
      return { status: "pending", providerStatus: String(r.status ?? "PENDING") };
  }
}
