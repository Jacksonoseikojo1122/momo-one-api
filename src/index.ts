import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { MtnMomoProvider } from "./providers/mtn.js";
import { PaystackProvider } from "./providers/paystack.js";
import { SandboxProvider } from "./providers/sandbox.js";
import { createApp } from "./server.js";
import { Payments } from "./service.js";
import { postgresStore, sqliteStore } from "./store.js";
import { NETWORKS, type Currency, type Network, type Provider } from "./types.js";

const env = process.env;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : undefined);
const fail = (msg: string) => {
  console.error(msg);
  process.exit(1);
};

const providers: Provider[] = [];
const mtnCreds = (p: "COLLECTION" | "DISBURSEMENT") =>
  env[`MTN_${p}_USER_ID`] && env[`MTN_${p}_API_KEY`] && env[`MTN_${p}_SUBSCRIPTION_KEY`]
    ? { userId: env[`MTN_${p}_USER_ID`]!, apiKey: env[`MTN_${p}_API_KEY`]!, subscriptionKey: env[`MTN_${p}_SUBSCRIPTION_KEY`]! }
    : undefined;
if (mtnCreds("COLLECTION") || mtnCreds("DISBURSEMENT")) {
  providers.push(
    new MtnMomoProvider({
      baseUrl: env.MTN_BASE_URL ?? "https://sandbox.momodeveloper.mtn.com",
      targetEnvironment: env.MTN_TARGET_ENVIRONMENT ?? "sandbox",
      callbackUrl: env.MTN_CALLBACK_URL,
      collection: mtnCreds("COLLECTION"),
      disbursement: mtnCreds("DISBURSEMENT"),
      // MTN's sandbox only accepts EUR; production in Ghana is GHS.
      currencies: (env.MTN_CURRENCIES ?? ((env.MTN_TARGET_ENVIRONMENT ?? "sandbox") === "sandbox" ? "EUR" : "GHS")).split(",") as Currency[],
    }),
  );
}
const paystack = env.PAYSTACK_SECRET_KEY ? new PaystackProvider({ secretKey: env.PAYSTACK_SECRET_KEY }) : undefined;
if (paystack) providers.push(paystack);
if (env.SANDBOX === "on") providers.push(new SandboxProvider(Number(env.SANDBOX_DELAY_MS ?? 3000)));
if (!providers.length) fail("No provider configured. Set SANDBOX=on to try it, or PAYSTACK_SECRET_KEY / MTN_* for real payments. See docs/getting-started.md.");

// ROUTES=mtn=mtn_momo,telecel=paystack,... ; otherwise the first configured provider that can serve each network.
const routes: Partial<Record<Network, string>> = {};
for (const pair of (env.ROUTES ?? "").split(",").filter(Boolean)) {
  const [n, p] = pair.split("=").map((s) => s.trim());
  if (!NETWORKS.includes(n as Network) || !providers.some((x) => x.name === p)) fail(`ROUTES: "${pair}" names an unknown network or an unconfigured provider`);
  routes[n as Network] = p;
}
for (const n of NETWORKS) {
  if (routes[n]) continue;
  const cur: Currency = n === "mpesa" ? "KES" : "GHS";
  routes[n] = providers.find((p) => p.name !== "sandbox" && (p.supports("collection", n, cur) || p.supports("payout", n, cur)))?.name ?? providers.find((p) => p.name === "sandbox")?.name;
}

const apiKeys = (env.MOMO_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
const real = providers.some((p) => p.name !== "sandbox");
if (real && !apiKeys.length) fail("MOMO_API_KEYS must be set when a real provider is configured.");
if (env.WEBHOOK_URL && !env.WEBHOOK_SECRET) fail("WEBHOOK_SECRET must be set with WEBHOOK_URL.");

const store = env.DATABASE_URL ? await postgresStore(env.DATABASE_URL) : sqliteStore(env.MOMO_SQLITE ?? "momo.db");
const payments = new Payments(store, providers, routes, env.WEBHOOK_URL ? { url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET! } : undefined);

const app = createApp({
  payments,
  store,
  apiKeys,
  paystack,
  mtnCallbackToken: env.MTN_CALLBACK_TOKEN,
  demo: env.DEMO === "on" && providers.some((p) => p.name === "sandbox"),
  files: { openapi: read("openapi.yaml"), llms: read("llms.txt") },
});

// Background work: status checks for open payments, webhook delivery, and a daily reconciliation.
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await payments.runDue();
    await payments.deliverDue();
  } catch (err) {
    console.error("background", err);
  } finally {
    busy = false;
  }
}, 1000).unref();
setInterval(() => payments.reconcile(24).then((r) => console.log("reconciliation", JSON.stringify(r))).catch(console.error), 24 * 3600_000).unref();

const port = Number(env.PORT ?? 8789);
serve({ fetch: app.fetch, port }, () =>
  console.log(`MoMo One-API on http://localhost:${port} (providers: ${providers.map((p) => p.name).join(", ")}; routes: ${JSON.stringify(routes)})`),
);
if (!apiKeys.length) console.warn("MOMO_API_KEYS is not set: the API is open. That's only allowed with the sandbox provider.");
