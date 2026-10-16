# Integrating MoMo One-API

## The flow

1. **Your checkout** calls `POST /v1/collections` with an `Idempotency-Key` tied to the order, e.g. `order-1001`.
2. **Tell the customer** to approve the prompt on their phone.
3. **Wait for the result.**
   - Mark the order paid when you get `payment.succeeded`.
   - Let them retry when you get `payment.failed`.
   - If the status is `action_required`, ask for the OTP and send it to `/v1/payments/{id}/otp`.
4. **Don't poll.** The API checks with the provider for you. Use `GET /v1/payments/{id}` only to show progress on screen.

Payouts work the same way, through `POST /v1/payouts`. A payout needs `customer.name`.

## Node.js / TypeScript

```ts
const MOMO = process.env.MOMO_URL!; // e.g. https://momo.your-app.com
const auth = { Authorization: `Bearer ${process.env.MOMO_API_KEY}` };

export async function chargeOrder(order: { id: string; totalPesewas: number; phone: string; network: string; email: string }) {
  const res = await fetch(`${MOMO}/v1/collections`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": `order-${order.id}` },
    body: JSON.stringify({
      amount: order.totalPesewas,
      currency: "GHS",
      phone: order.phone,
      network: order.network, // ask the customer: numbers can move between networks
      customer: { email: order.email },
      description: `Order ${order.id}`,
      metadata: { order_id: order.id },
    }),
  });
  const payment = await res.json();
  if (!res.ok) throw new Error(payment.error);
  return payment; // save payment.id with the order; status is "pending" or "action_required"
}
```

## Python

```python
import os, requests

MOMO = os.environ["MOMO_URL"]
AUTH = {"Authorization": f"Bearer {os.environ['MOMO_API_KEY']}"}

def pay_out(ref: str, pesewas: int, phone: str, network: str, name: str) -> dict:
    r = requests.post(f"{MOMO}/v1/payouts", headers={**AUTH, "Idempotency-Key": f"payout-{ref}"}, json={
        "amount": pesewas, "currency": "GHS", "phone": phone, "network": network,
        "customer": {"name": name}, "description": f"Refund {ref}",
    })
    r.raise_for_status()  # a retry with the same key returns the same payout, never a second one
    return r.json()
```

## PHP

```php
$res = Http::withToken(env('MOMO_API_KEY'))
    ->withHeaders(['Idempotency-Key' => 'order-' . $order->id])
    ->post(env('MOMO_URL') . '/v1/collections', [
        'amount' => $order->total_pesewas, 'currency' => 'GHS',
        'phone' => $order->phone, 'network' => $order->network,
        'customer' => ['email' => $order->email],
    ])->throw()->json();
```

## Webhooks

Every status change is POSTed to `WEBHOOK_URL`:

```http
POST /webhooks/momo
Content-Type: application/json
X-Webhook-Id: evt_5c1e...
X-MoMo-One-Event: payment.succeeded
X-Signature: sha256=8f2a...

{ "id": "evt_5c1e...", "type": "payment.succeeded", "created_at": "2026-10-16T04:40:35.000Z",
  "data": { "id": "pay_073f...", "status": "succeeded", "amount": 2500, "currency": "GHS", "metadata": { "order_id": "1001" }, ... } }
```

**Event types:**
- `payment.pending`
- `payment.action_required`
- `payment.succeeded`
- `payment.failed`
- `payment.reversed`
- `payment.mismatch` (a provider changed its answer after the payment was final; see [how it works](how-it-works.md#the-reconciler))

**How to handle them:**
- Verify the signature on the raw body.
- Make your handler idempotent on `X-Webhook-Id` (the same event can arrive twice).
- Reply `2xx` quickly.

```ts
import crypto from "node:crypto";

app.post("/webhooks/momo", express.raw({ type: "application/json" }), async (req, res) => {
  const want = "sha256=" + crypto.createHmac("sha256", process.env.MOMO_WEBHOOK_SECRET!).update(req.body).digest("hex");
  const got = req.get("x-signature") ?? "";
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.sendStatus(401);

  const event = JSON.parse(req.body.toString());
  if (await alreadyHandled(event.id)) return res.sendStatus(200);
  if (event.type === "payment.succeeded") await markOrderPaid(event.data.metadata.order_id, event.data.id);
  if (event.type === "payment.failed") await markOrderUnpaid(event.data.metadata.order_id, event.data.failure.code);
  res.sendStatus(200);
});
```

### Through Webhook Relay

This is the same signature format [Webhook Relay](https://github.com/Jacksonoseikojo1122/webhook-relay)'s `generic` source checks, with `X-Webhook-Id` as the duplicate key. Add a source to `relay.json`:

```json
{ "name": "momo", "provider": "generic", "secret": "$MOMO_WEBHOOK_SECRET",
  "destination": "https://your-app.com/webhooks/momo", "destination_secret": "$RELAY_TO_APP_SECRET" }
```

Then set `WEBHOOK_URL=https://<relay>/in/momo`. The relay stores every event, drops duplicates, and keeps retrying your app with backoff. It also gives you a dashboard and replay. Your app then verifies the relay's `X-Relay-Signature` instead.

## Errors

| HTTP | When |
| --- | --- |
| `400` | Invalid input (the response lists each `issues[].path`), or no `Idempotency-Key` |
| `401` | Missing or wrong API key |
| `404` | Payment not found, or it belongs to another API key |
| `409` | `Idempotency-Key` reused with a different body, or an OTP sent when none is expected |
| `422` | No provider for that network or currency |

A provider refusing a payment is not an HTTP error. You get `201` with `status: "failed"` and a `failure.code`.
