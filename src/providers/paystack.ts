import { createHmac, timingSafeEqual } from "node:crypto";
import { localFormat } from "../phone.js";
import { type Currency, type Direction, type FailureCode, type Network, type Payment, type Provider, ProviderRejected, type ProviderResult, ProviderUnreachable } from "../types.js";
import { ageMs, call } from "./http.js";

// Paystack (paystack.com/docs): mobile money charges in Ghana (mtn, vod = Telecel, atl = AirtelTigo)
// and Kenya (mpesa); payouts are transfers to "mobile_money" recipients from your Paystack balance.
// Charges come back "pay_offline": the customer approves on their phone within 180 seconds.
// We pass our own reference on charges and transfers, so a timed-out request can always be verified.

const CHARGE_CODE: Record<Network, string> = { mtn: "mtn", telecel: "vod", airteltigo: "atl", mpesa: "mpesa" };
const CURRENCY: Record<Network, Currency> = { mtn: "GHS", telecel: "GHS", airteltigo: "GHS", mpesa: "KES" };

export type PaystackConfig = { secretKey: string; baseUrl?: string };

export class PaystackProvider implements Provider {
  readonly name = "paystack";
  private telcos = new Map<Currency, { name: string; code: string }[]>();
  constructor(private cfg: PaystackConfig) {}

  supports(_d: Direction, network: Network, currency: Currency) {
    return CURRENCY[network] === currency;
  }

  async collect(p: Payment): Promise<ProviderResult> {
    if (!p.customer.email) throw new ProviderRejected("Paystack needs customer.email for mobile money charges", "not_allowed");
    const res = await this.api("POST", "/charge", {
      email: p.customer.email,
      amount: String(p.amount),
      currency: p.currency,
      reference: p.reference,
      mobile_money: { phone: this.chargePhone(p), provider: CHARGE_CODE[p.network] },
      metadata: { momo_one_id: p.id },
    });
    return mapCharge(res.data);
  }

  async submitOtp(p: Payment, otp: string): Promise<ProviderResult> {
    const res = await this.api("POST", "/charge/submit_otp", { otp, reference: p.reference });
    return mapCharge(res.data);
  }

  async payout(p: Payment): Promise<ProviderResult> {
    const bankCode = await this.telcoCode(p.network, p.currency);
    const recipient = await this.api("POST", "/transferrecipient", {
      type: "mobile_money",
      name: p.customer.name || p.phone,
      account_number: p.network === "mpesa" ? p.phone : localFormat(p.phone),
      bank_code: bankCode,
      currency: p.currency,
    });
    const res = await this.api("POST", "/transfer", {
      source: "balance",
      amount: p.amount,
      reference: p.reference,
      recipient: recipient.data?.recipient_code,
      reason: p.description ?? "Payout",
    });
    return mapTransfer(res.data);
  }

  async status(p: Payment): Promise<ProviderResult> {
    const path = p.direction === "collection" ? "/transaction/verify/" : "/transfer/verify/";
    const res = await call(this.base() + path + encodeURIComponent(p.reference), { method: "GET", headers: this.headers() });
    if (res.status === 404 || (res.status === 400 && /not found/i.test(res.body?.message ?? ""))) {
      if (ageMs(p.created_at) < 120_000) return { status: "pending", providerStatus: "not_found_yet" };
      return { status: "failed", providerStatus: "not_found", failure: { code: "provider_error", message: "Paystack has no record of this reference." } };
    }
    if (res.status >= 500 || !res.body?.data) throw new ProviderUnreachable(`Paystack verify returned HTTP ${res.status}`);
    return p.direction === "collection" ? mapCharge(res.body.data) : mapTransfer(res.body.data);
  }

  /** x-paystack-signature: HMAC-SHA512 of the raw body with your secret key. */
  verifyWebhook(raw: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const want = createHmac("sha512", this.cfg.secretKey).update(raw).digest("hex");
    return want.length === signature.length && timingSafeEqual(Buffer.from(want), Buffer.from(signature));
  }

  /** Telco codes for transfer recipients come from Paystack's own List Banks endpoint, not a hard-coded list. */
  private async telcoCode(network: Network, currency: Currency): Promise<string> {
    if (network === "mpesa") return "MPESA";
    let list = this.telcos.get(currency);
    if (!list) {
      const res = await this.api("GET", `/bank?currency=${currency}&type=mobile_money`);
      list = (res.data ?? []).map((b: any) => ({ name: String(b.name), code: String(b.code) }));
      this.telcos.set(currency, list!);
    }
    const match = { mtn: /mtn/i, telecel: /telecel|vodafone/i, airteltigo: /airtel|tigo|\bat\b/i }[network as "mtn"];
    const found = list!.find((b) => match.test(b.name));
    if (!found) throw new ProviderRejected(`Paystack doesn't list a ${network} mobile money option for ${currency}`, "not_allowed");
    return found.code;
  }

  private chargePhone(p: Payment) {
    // Paystack's examples use 0551234987 for Ghana and +254... for M-Pesa.
    return p.network === "mpesa" ? "+" + p.phone : localFormat(p.phone);
  }

  private async api(method: string, path: string, body?: object) {
    const res = await call(this.base() + path, {
      method,
      headers: { ...this.headers(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status >= 500) throw new ProviderUnreachable(`Paystack returned HTTP ${res.status}`);
    if (res.status >= 400 || res.body?.status === false) {
      throw new ProviderRejected(res.body?.message || `Paystack refused the request (HTTP ${res.status})`);
    }
    return res.body;
  }

  private headers() {
    return { Authorization: `Bearer ${this.cfg.secretKey}` };
  }
  private base() {
    return (this.cfg.baseUrl ?? "https://api.paystack.co").replace(/\/$/, "");
  }
}

function failureFor(message: string | undefined, fallback: FailureCode): { code: FailureCode; message: string } {
  const m = (message ?? "").toLowerCase();
  const code: FailureCode = /insufficient|not enough/.test(m) ? "insufficient_funds" : /declin|cancel|reject/.test(m) ? "declined" : /expire|timeout|timed out/.test(m) ? "expired" : fallback;
  return { code, message: message || "The provider reported the payment as failed." };
}

/** Charge or transaction status -> our status. */
export function mapCharge(d: any): ProviderResult {
  const s = String(d?.status ?? "");
  const base = { providerStatus: s, providerReference: d?.id != null ? String(d.id) : null };
  switch (s) {
    case "success":
      return { status: "succeeded", ...base };
    case "failed":
      return { status: "failed", ...base, failure: failureFor(d.gateway_response || d.message, "unknown") };
    case "abandoned":
      return { status: "failed", ...base, failure: { code: "declined", message: d.gateway_response || "The customer didn't complete the payment." } };
    case "reversed":
      return { status: "reversed", ...base };
    case "send_otp":
      return { status: "action_required", ...base, action: { type: "otp", message: d.display_text || "Enter the code sent to the customer's phone." } };
    default: // pay_offline, pending, ongoing, processing, queued
      return { status: "pending", ...base };
  }
}

/** Transfer status -> our status. */
export function mapTransfer(d: any): ProviderResult {
  const s = String(d?.status ?? "");
  const base = { providerStatus: s, providerReference: d?.transfer_code ?? null };
  switch (s) {
    case "success":
      return { status: "succeeded", ...base };
    case "reversed":
      return { status: "reversed", ...base };
    case "failed":
    case "abandoned":
    case "rejected":
    case "blocked":
      return { status: "failed", ...base, failure: failureFor(d.gateway_response || d.failures?.[0] || s, s === "failed" ? "provider_error" : "not_allowed") };
    default: // pending, received, queued, otp (turn off "Confirm transfers before sending" for automated payouts)
      return { status: "pending", ...base };
  }
}
