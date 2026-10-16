import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MtnMomoProvider } from "../src/providers/mtn.js";
import { PaystackProvider } from "../src/providers/paystack.js";
import { createApp } from "../src/server.js";
import { Payments } from "../src/service.js";
import { sqliteStore } from "../src/store.js";
import type { Payment } from "../src/types.js";
import { fakeServer } from "./helpers.js";

const payment = (over: Partial<Payment> = {}): Payment => ({
  id: "pay_test",
  direction: "collection",
  status: "pending",
  amount: 1050,
  currency: "GHS",
  phone: "233241234567",
  network: "mtn",
  provider: "x",
  reference: "3f7c2d1e-5b6a-4c8d-9e0f-1a2b3c4d5e6f",
  provider_reference: null,
  provider_status: null,
  failure: null,
  action: null,
  customer: { email: "ama@example.com", name: "Ama Mensah" },
  description: "Order 42",
  metadata: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: null,
  ...over,
});

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

// Shapes below follow MTN's published Collection / Disbursement API definitions.
describe("MTN MoMo", () => {
  async function mtn(statusBody: object | null = { status: "PENDING" }, createStatus = 202) {
    let tokens = 0;
    const srv = await fakeServer((r) => {
      if (r.path.endsWith("/token/")) {
        tokens++;
        return { status: 200, body: { access_token: "tok-" + tokens, token_type: "access_token", expires_in: 3600 } };
      }
      if (r.method === "POST") return createStatus === 409 ? { status: 409, body: { code: "RESOURCE_ALREADY_EXIST", message: "Duplicated reference id." } } : { status: createStatus, body: createStatus >= 400 ? { code: "PAYER_NOT_FOUND", message: "Payer not found" } : undefined };
      return statusBody ? { status: 200, body: statusBody } : { status: 404, body: { code: "RESOURCE_NOT_FOUND" } };
    });
    servers.push(srv);
    const creds = { userId: "user-1", apiKey: "key-1", subscriptionKey: "sub-1" };
    const p = new MtnMomoProvider({ baseUrl: srv.url, targetEnvironment: "sandbox", callbackUrl: "https://example.com/webhooks/mtn?token=t", collection: creds, disbursement: creds, currencies: ["GHS", "EUR"] });
    return { p, srv, tokens: () => tokens };
  }

  it("sends RequesttoPay with the documented headers and body", async () => {
    const { p, srv } = await mtn();
    expect(await p.collect(payment())).toEqual({ status: "pending", providerStatus: "PENDING" });
    const [token, create] = srv.seen;
    expect(token!.path).toBe("/collection/token/");
    expect(token!.headers.authorization).toBe("Basic " + Buffer.from("user-1:key-1").toString("base64"));
    expect(token!.headers["ocp-apim-subscription-key"]).toBe("sub-1");
    expect(create!.path).toBe("/collection/v1_0/requesttopay");
    expect(create!.headers).toMatchObject({
      authorization: "Bearer tok-1",
      "x-reference-id": "3f7c2d1e-5b6a-4c8d-9e0f-1a2b3c4d5e6f",
      "x-target-environment": "sandbox",
      "x-callback-url": "https://example.com/webhooks/mtn?token=t",
      "ocp-apim-subscription-key": "sub-1",
    });
    expect(create!.body).toEqual({
      amount: "10.50",
      currency: "GHS",
      externalId: "pay_test",
      payer: { partyIdType: "MSISDN", partyId: "233241234567" },
      payerMessage: "Order 42",
      payeeNote: "Order 42",
    });
  });

  it("reuses the token until it expires", async () => {
    const { p, tokens } = await mtn();
    await p.collect(payment());
    await p.status(payment());
    expect(tokens()).toBe(1);
  });

  it("sends payouts to Disbursement Transfer", async () => {
    const { p, srv } = await mtn();
    await p.payout(payment({ direction: "payout" }));
    expect(srv.seen[1]!.path).toBe("/disbursement/v1_0/transfer");
    expect(srv.seen[1]!.body.payee).toEqual({ partyIdType: "MSISDN", partyId: "233241234567" });
  });

  it("treats a duplicate reference as already created", async () => {
    const { p } = await mtn(undefined, 409);
    expect((await p.collect(payment())).status).toBe("pending");
  });

  it("maps statuses and reasons", async () => {
    expect(await (await mtn({ status: "SUCCESSFUL", financialTransactionId: "FT1" })).p.status(payment())).toMatchObject({ status: "succeeded", providerReference: "FT1" });
    const failed = await (await mtn({ status: "FAILED", reason: { code: "NOT_ENOUGH_FUNDS", message: "Low balance" } })).p.status(payment());
    expect(failed).toMatchObject({ status: "failed", failure: { code: "insufficient_funds" } });
    const rejected = await (await mtn({ status: "FAILED", reason: "APPROVAL_REJECTED" })).p.status(payment());
    expect(rejected.failure?.code).toBe("declined");
  });

  it("only gives up on an unknown reference after two minutes", async () => {
    const { p } = await mtn(null);
    expect((await p.status(payment())).status).toBe("pending");
    expect((await p.status(payment({ created_at: new Date(Date.now() - 180_000).toISOString() }))).status).toBe("failed");
  });

  it("an MTN callback needs the URL token and only triggers a status check", async () => {
    const { p, srv } = await mtn({ status: "SUCCESSFUL", financialTransactionId: "FT9" });
    const store = sqliteStore();
    const payments = new Payments(store, [p], { mtn: "mtn_momo" });
    const app = createApp({ payments, store, apiKeys: ["k"], mtnCallbackToken: "cb-secret" });
    const created = await (
      await app.request("/v1/collections", {
        method: "POST",
        headers: { authorization: "Bearer k", "idempotency-key": "1", "content-type": "application/json" },
        body: JSON.stringify({ amount: 500, currency: "GHS", phone: "0241234567", network: "mtn" }),
      })
    ).json();
    // The body claims FAILED, but the status comes from asking MTN, which says SUCCESSFUL.
    const body = JSON.stringify({ externalId: created.id, status: "FAILED" });
    expect((await app.request("/webhooks/mtn?token=wrong", { method: "POST", body })).status).toBe(403);
    expect((await app.request("/webhooks/mtn?token=cb-secret", { method: "POST", body })).status).toBe(200);
    expect(srv.seen.at(-1)!.path).toBe(`/collection/v1_0/requesttopay/${created.reference}`);
    expect((await store.get(created.id))!.payment).toMatchObject({ status: "succeeded", provider_reference: "FT9" });
  });

  it("only routes MTN numbers in configured currencies", async () => {
    const { p } = await mtn();
    expect(p.supports("collection", "mtn", "GHS")).toBe(true);
    expect(p.supports("collection", "telecel", "GHS")).toBe(false);
    expect(p.supports("collection", "mtn", "KES")).toBe(false);
  });
});

// Shapes below follow Paystack's Charge, Transfer and Verify docs.
describe("Paystack", () => {
  async function paystack(chargeStatus = "pay_offline", verifyData: object = { status: "success", id: 99, reference: "r" }) {
    const srv = await fakeServer((r) => {
      if (r.path === "/charge") return { status: 200, body: { status: true, message: "Charge attempted", data: { reference: r.body.reference, status: chargeStatus, display_text: "Please complete authorization process on your mobile phone" } } };
      if (r.path === "/charge/submit_otp") return { status: 200, body: { status: true, data: { status: "pay_offline", reference: r.body.reference } } };
      if (r.path.startsWith("/bank")) return { status: 200, body: { status: true, data: [{ name: "MTN", code: "MTN" }, { name: "Telecel Ghana", code: "VOD" }, { name: "AirtelTigo", code: "ATL" }] } };
      if (r.path === "/transferrecipient") return { status: 201, body: { status: true, data: { recipient_code: "RCP_1" } } };
      if (r.path === "/transfer") return { status: 200, body: { status: true, data: { status: "pending", transfer_code: "TRF_1", reference: r.body.reference } } };
      if (r.path.startsWith("/transaction/verify/") || r.path.startsWith("/transfer/verify/")) return { status: 200, body: { status: true, data: verifyData } };
      return { status: 404, body: { status: false, message: "not found" } };
    });
    servers.push(srv);
    return { p: new PaystackProvider({ secretKey: "sk_test_x", baseUrl: srv.url }), srv };
  }

  it("charges with the documented provider codes and phone formats", async () => {
    const { p, srv } = await paystack();
    expect((await p.collect(payment({ network: "telecel" }))).status).toBe("pending");
    await p.collect(payment({ network: "airteltigo" }));
    await p.collect(payment({ network: "mpesa", currency: "KES", phone: "254712345678" }));
    const bodies = srv.seen.map((s) => s.body);
    expect(bodies[0]).toMatchObject({ email: "ama@example.com", amount: "1050", currency: "GHS", reference: payment().reference, mobile_money: { phone: "0241234567", provider: "vod" } });
    expect(bodies[1].mobile_money.provider).toBe("atl");
    expect(bodies[2].mobile_money).toEqual({ phone: "+254712345678", provider: "mpesa" });
    expect(srv.seen[0]!.headers.authorization).toBe("Bearer sk_test_x");
  });

  it("needs an email for charges", async () => {
    const { p } = await paystack();
    await expect(p.collect(payment({ customer: {} }))).rejects.toThrow(/email/);
  });

  it("asks for an OTP when Paystack does", async () => {
    const { p } = await paystack("send_otp");
    const r = await p.collect(payment());
    expect(r).toMatchObject({ status: "action_required", action: { type: "otp" } });
    expect((await p.submitOtp!(payment(), "123456")).status).toBe("pending");
  });

  it("pays out through a mobile money recipient, using Paystack's own telco codes", async () => {
    const { p, srv } = await paystack();
    const r = await p.payout(payment({ direction: "payout", network: "telecel" }));
    expect(r).toMatchObject({ status: "pending", providerReference: "TRF_1" });
    const [bank, recipient, transfer] = srv.seen;
    expect(bank!.path).toBe("/bank?currency=GHS&type=mobile_money");
    expect(recipient!.body).toEqual({ type: "mobile_money", name: "Ama Mensah", account_number: "0241234567", bank_code: "VOD", currency: "GHS" });
    expect(transfer!.body).toEqual({ source: "balance", amount: 1050, reference: payment().reference, recipient: "RCP_1", reason: "Order 42" });
  });

  it("maps verify statuses", async () => {
    expect((await (await paystack(undefined, { status: "success", id: 7 })).p.status(payment())).status).toBe("succeeded");
    expect((await (await paystack(undefined, { status: "abandoned" })).p.status(payment())).failure?.code).toBe("declined");
    expect((await (await paystack(undefined, { status: "ongoing" })).p.status(payment())).status).toBe("pending");
    expect((await (await paystack(undefined, { status: "reversed", transfer_code: "TRF_1" })).p.status(payment({ direction: "payout" }))).status).toBe("reversed");
    expect((await (await paystack(undefined, { status: "otp" })).p.status(payment({ direction: "payout" }))).status).toBe("pending");
  });

  it("verifies webhook signatures (HMAC-SHA512 with the secret key)", async () => {
    const { p } = await paystack();
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "abc" } });
    const sig = createHmac("sha512", "sk_test_x").update(raw).digest("hex");
    expect(p.verifyWebhook(raw, sig)).toBe(true);
    expect(p.verifyWebhook(raw, sig.replace(/^./, "0"))).toBe(false);
    expect(p.verifyWebhook(raw, undefined)).toBe(false);
  });

  it("a signed webhook makes us re-check the payment with Paystack", async () => {
    const { p, srv } = await paystack("pay_offline", { status: "success", id: 5 });
    const store = sqliteStore();
    const payments = new Payments(store, [p], { mtn: "paystack" });
    const app = createApp({ payments, store, apiKeys: ["k"], paystack: p });
    const created = await (
      await app.request("/v1/collections", {
        method: "POST",
        headers: { authorization: "Bearer k", "idempotency-key": "1", "content-type": "application/json" },
        body: JSON.stringify({ amount: 500, currency: "GHS", phone: "0241234567", network: "mtn", customer: { email: "a@b.co" } }),
      })
    ).json();
    expect(created.status).toBe("pending");

    const raw = JSON.stringify({ event: "charge.success", data: { reference: created.reference, status: "success" } });
    const forged = await app.request("/webhooks/paystack", { method: "POST", headers: { "x-paystack-signature": "nope" }, body: raw });
    expect(forged.status).toBe(401);
    const ok = await app.request("/webhooks/paystack", { method: "POST", headers: { "x-paystack-signature": createHmac("sha512", "sk_test_x").update(raw).digest("hex") }, body: raw });
    expect(ok.status).toBe(200);
    expect(srv.seen.at(-1)!.path).toBe(`/transaction/verify/${created.reference}`);
    expect((await store.get(created.id))!.payment.status).toBe("succeeded");
  });
});
