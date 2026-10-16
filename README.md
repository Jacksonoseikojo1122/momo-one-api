# MoMo One-API

One clean API and one webhook format across MTN MoMo, Telecel Cash, AirtelTigo Money and M-Pesa.

[![CI](https://github.com/Jacksonoseikojo1122/momo-one-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Jacksonoseikojo1122/momo-one-api/actions/workflows/ci.yml)

Every mobile money network and aggregator has its own API, its own statuses and its own webhook shape. MTN says `SUCCESSFUL`, Paystack says `success`, and one provider's "pending" is another's "pay_offline". Adding or switching a provider means rewriting your payment code.

MoMo One-API is a small service you run next to your app. You send it one request format. It routes the payment to a licensed provider, maps whatever comes back onto five statuses, keeps checking until the payment is final, and tells you with one signed webhook format.

**It never holds money.** Collections go straight from the customer to your own account at the provider (Paystack, or MTN MoMo directly), and payouts come from that account. This service only sends instructions and records statuses.

![The built-in sandbox: a GHS 25.00 MTN collection that succeeded, with its webhook events](docs/images/sandbox-succeeded.jpg)

## What you get

- **One request** for collections and payouts on `mtn`, `telecel`, `airteltigo` and `mpesa`. Amounts are in minor units, and phone numbers can be in any common format.
- **One state machine:** `pending`, `action_required` (OTP), `succeeded`, `failed` (with a normalised `failure.code`) and `reversed`.
- **No double charges.** An `Idempotency-Key` is required on every create. Each payment is saved before the provider is called, and carries our own reference, so a timeout is resolved by asking the provider.
- **Webhooks in are verified.** Paystack's are checked against its signature, and MTN's need a URL token. Neither is trusted for the status: the provider is always asked.
- **Webhooks out are signed** in the format [Webhook Relay](https://github.com/Jacksonoseikojo1122/webhook-relay) already checks, with retries from an outbox.
- **Reconciliation.** Open payments are re-checked until final, and finished ones are re-checked daily. If a provider changes its answer, it's flagged for a person to look at, never silently overwritten.
- **A sandbox** with test numbers for success, decline, insufficient funds, OTP, reversal and stuck payments, plus a demo page.
- **Providers:** Paystack (Ghana's three networks, and M-Pesa) and MTN's MoMo API directly. Each adapter was written from the provider's own documentation.

## Quick start

```bash
git clone https://github.com/Jacksonoseikojo1122/momo-one-api.git
cd momo-one-api && npm install
SANDBOX=on DEMO=on npm start     # demo page at http://localhost:8789
```

```bash
curl -X POST localhost:8789/v1/collections \
  -H "content-type: application/json" -H "Idempotency-Key: order-1001" \
  -d '{"amount":2500,"currency":"GHS","phone":"024 123 4567","network":"mtn","customer":{"email":"ama@example.com"}}'
```

Then add `PAYSTACK_SECRET_KEY` and/or your MTN keys, plus `MOMO_API_KEYS`, and the same request moves real money through your provider account. See [getting started](docs/getting-started.md).

![A Telecel collection that failed with insufficient funds](docs/images/sandbox-failed.jpg)

## Docs

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Sandbox, real providers, configuration |
| [Integration guide](docs/integration.md) | Node, Python and PHP; verifying webhooks; using Webhook Relay |
| [How it works](docs/how-it-works.md) | Never holding funds, statuses, failure codes, idempotency, reconciliation |
| [Providers](docs/providers.md) | Paystack and MTN setup, with the official docs each adapter follows |
| [Sandbox](docs/sandbox.md) | Test numbers and what they do |
| [OpenAPI spec](openapi.yaml) | Every endpoint, plus the outgoing webhook |
| [llms.txt](llms.txt) | A summary for AI assistants helping you integrate |

![How it works](docs/images/how-it-works.svg)

## Before you go live

- Run a real test payment through each provider's own sandbox or test mode. The adapters are tested against fake servers built from the providers' docs, not against the providers themselves.
- For MTN, confirm the amount format and your target environment with MTN ([providers.md](docs/providers.md#mtn-momo-direct-mtn_momo)).
- For automated Paystack payouts, turn off *Confirm transfers before sending*.
- You need your own agreement with each provider. This software doesn't replace that, and it isn't financial or legal advice.

## Author

Built by **[Jackson Kojo Osei](https://jacksonkojoosei.com)**, CTO in Accra, Ghana.
[LinkedIn](https://www.linkedin.com/in/jackson-kojo-osei-740846189) · [Project page](https://jacksonkojoosei.com/projects/momo-one-api) · [All projects](https://jacksonkojoosei.com/projects)

## License

MIT
