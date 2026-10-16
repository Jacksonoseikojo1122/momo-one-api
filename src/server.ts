import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { demoPage } from "./demo.js";
import type { PaystackProvider } from "./providers/paystack.js";
import { ApiError, type Payments } from "./service.js";
import type { Store } from "./store.js";
import type { Payment, Status } from "./types.js";

export type AppOptions = {
  payments: Payments;
  store: Store;
  apiKeys: string[]; // empty = open, which the entrypoint only allows with the sandbox
  paystack?: PaystackProvider; // for webhook signatures
  mtnCallbackToken?: string;
  demo?: boolean;
  files?: { openapi?: string; llms?: string };
};

type Env = { Variables: { owner: string } };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const STATUSES = ["pending", "action_required", "succeeded", "failed", "reversed"] as const;

/** What the API returns for a payment (the full record minus internal fields). */
const view = (p: Payment) => p;

export function createApp(o: AppOptions) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
    if (err instanceof SyntaxError) return c.json({ error: "Body must be valid JSON" }, 400);
    console.error(err);
    return c.json({ error: "Something went wrong" }, 500);
  });
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Body is larger than 64 KB" }, 413) }));

  app.get("/health", async (c) => {
    await o.store.ping();
    return c.json({ ok: true, ...o.payments.routing() });
  });
  if (o.files?.openapi) app.get("/openapi.yaml", (c) => c.body(o.files!.openapi!, 200, { "content-type": "application/yaml" }));
  if (o.files?.llms) app.get("/llms.txt", (c) => c.text(o.files!.llms!));

  // --- Your API --------------------------------------------------------------
  app.use("/v1/*", async (c, next) => {
    if (!o.apiKeys.length) {
      c.set("owner", "dev");
      return next();
    }
    const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!o.apiKeys.includes(key)) return c.json({ error: "Missing or invalid API key" }, 401);
    c.set("owner", sha(key).slice(0, 16));
    return next();
  });

  const create = (direction: "collection" | "payout") => async (c: Context<Env>) => {
    const key = c.req.header("idempotency-key")?.trim();
    if (!key || key.length > 128) return c.json({ error: "Send an Idempotency-Key header (up to 128 characters) so a retry never charges or pays twice" }, 400);
    const { payment, replayed } = await o.payments.create(c.get("owner"), direction, key, await c.req.text());
    c.header("Idempotent-Replayed", String(replayed));
    return c.json(view(payment), replayed ? 200 : 201);
  };
  app.post("/v1/collections", create("collection"));
  app.post("/v1/payouts", create("payout"));

  app.get("/v1/payments", async (c) => {
    const status = c.req.query("status");
    const direction = c.req.query("direction");
    if (status && !STATUSES.includes(status as Status)) return c.json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const list = await o.store.list(c.get("owner"), { status: status as Status | undefined, direction, limit });
    return c.json({ payments: list.map(view) });
  });
  app.get("/v1/payments/:id", async (c) => c.json(view((await o.payments.get(c.get("owner"), c.req.param("id"))).payment)));
  app.post("/v1/payments/:id/refresh", async (c) => c.json(view(await o.payments.refresh(c.get("owner"), c.req.param("id")))));
  app.post("/v1/payments/:id/otp", async (c) => {
    const { otp } = z.object({ otp: z.string().regex(/^\d{4,8}$/, "otp is 4 to 8 digits") }).parse(await c.req.json());
    return c.json(view(await o.payments.submitOtp(c.get("owner"), c.req.param("id"), otp)));
  });
  app.get("/v1/payments/:id/events", async (c) => {
    await o.payments.get(c.get("owner"), c.req.param("id"));
    const events = await o.store.events(c.get("owner"), c.req.param("id"));
    return c.json({ events: events.map(eventView) });
  });
  app.get("/v1/events", async (c) => c.json({ events: (await o.store.events(c.get("owner"))).map(eventView) }));
  app.get("/v1/reconciliation", async (c) => c.json(await o.payments.report(c.get("owner"))));
  app.post("/v1/reconciliation/run", async (c) => c.json(await o.payments.reconcile(Number(c.req.query("hours") ?? 24) || 24)));
  app.get("/v1/routing", (c) => c.json(o.payments.routing()));

  // --- Provider callbacks ------------------------------------------------------
  // MTN callbacks aren't signed, so the URL carries a secret token, and the body is only
  // used to find the payment: its status always comes from asking MTN.
  app.post("/webhooks/mtn", async (c) => {
    if (!o.mtnCallbackToken || c.req.query("token") !== o.mtnCallbackToken) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({}));
    await o.payments.notify("mtn_momo", { id: typeof body?.externalId === "string" ? body.externalId : undefined });
    return c.body(null, 200);
  });

  app.post("/webhooks/paystack", async (c) => {
    const raw = await c.req.text();
    if (!o.paystack?.verifyWebhook(raw, c.req.header("x-paystack-signature"))) return c.json({ error: "bad signature" }, 401);
    const event = JSON.parse(raw);
    const ref = event?.data?.reference;
    if (typeof ref === "string") await o.payments.notify("paystack", { reference: ref });
    return c.body(null, 200);
  });

  // --- Sandbox demo (DEMO=on) -------------------------------------------------
  if (o.demo) {
    app.get("/", (c) => c.html(demoPage()));
    app.post("/demo/collections", async (c) => {
      const body = await c.req.json();
      const { payment } = await o.payments.create("demo", body.direction === "payout" ? "payout" : "collection", crypto.randomUUID(),
        JSON.stringify({ ...body, direction: undefined, provider: "sandbox" }));
      return c.json(payment, 201);
    });
    app.get("/demo/payments/:id", async (c) => {
      const payment = await o.payments.refresh("demo", c.req.param("id")); // ask the sandbox now rather than waiting for the reconciler
      return c.json({ payment, events: (await o.store.events("demo", payment.id)).map(eventView) });
    });
    app.post("/demo/payments/:id/otp", async (c) => {
      const { otp } = await c.req.json();
      return c.json(await o.payments.submitOtp("demo", c.req.param("id"), String(otp)));
    });
  }
  return app;
}

function eventView(e: { id: string; type: string; created_at: string; attempts: number; delivered_at: string | null; last_error: string | null; body: string }) {
  return { id: e.id, type: e.type, created_at: e.created_at, attempts: e.attempts, delivered_at: e.delivered_at, last_error: e.last_error, data: JSON.parse(e.body).data };
}
