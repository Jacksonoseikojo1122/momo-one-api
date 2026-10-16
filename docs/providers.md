# Providers

Each adapter was written from the provider's own documentation, which is linked below. In tests, each one runs against a fake server that answers the way those docs describe. Before going live, run a real test payment in each provider's sandbox or test mode.

## Paystack: `paystack`

**Covers:**
- collections and payouts on MTN, Telecel and AirtelTigo in Ghana (GHS);
- M-Pesa in Kenya (KES).

**Key:** `PAYSTACK_SECRET_KEY`, from Dashboard → Settings → API Keys & Webhooks. Use `sk_test_...` first.

**Webhook URL:** `https://<your-host>/webhooks/paystack` (same page). Events are checked against `x-paystack-signature`, HMAC-SHA512 of the body using your secret key.

| | Paystack API | Notes |
| --- | --- | --- |
| Collection | `POST /charge` with `mobile_money: { phone, provider }` | Provider codes `mtn`, `vod` (Telecel), `atl` (AirtelTigo), `mpesa`. Ghana numbers are sent as `0241234567`, Kenyan ones as `+254...`. A `customer.email` is required |
| Customer approval | `data.status: "pay_offline"` | The customer approves on their phone within 180 seconds |
| OTP | `data.status: "send_otp"`, then `POST /charge/submit_otp` | Shown as `action_required` |
| Collection status | `GET /transaction/verify/{reference}` | `success`, `failed`, `abandoned`, `reversed`; anything else counts as pending |
| Payout | `POST /transferrecipient` (`type: "mobile_money"`), then `POST /transfer` (`source: "balance"`) | Telco codes come from Paystack's own `GET /bank?currency=GHS&type=mobile_money`. M-Pesa uses `MPESA` |
| Payout status | `GET /transfer/verify/{reference}` | `success`, `failed`, `reversed`, `abandoned`, `rejected`, `blocked`; `otp`, `pending` and `received` count as pending |

**Sources:**
- [Payment channels: mobile money](https://paystack.com/docs/payments/payment-channels/)
- [Charge API](https://paystack.com/docs/api/charge/)
- [Transfer recipients](https://paystack.com/docs/transfers/creating-transfer-recipients/)
- [Single transfers](https://paystack.com/docs/transfers/single-transfers/)
- [How transfers work](https://paystack.com/docs/transfers/how-transfers-work/)
- [Webhooks](https://paystack.com/docs/payments/webhooks/)

**Automated payouts and OTPs.** Paystack asks for an OTP on transfers unless you turn off *Confirm transfers before sending* (Dashboard → Preferences). Until you do, transfers sit at `otp`, which shows as `pending`.

## MTN MoMo direct: `mtn_momo`

**Covers:** MTN in Ghana: Collection (RequesttoPay) and Disbursement (Transfer).

**Keys:** sign up at [momodeveloper.mtn.com](https://momodeveloper.mtn.com) and subscribe to Collection and/or Disbursements. That gives a subscription key for each product. Then create an API user and API key in the sandbox (the "Sandbox User Provisioning" API), or get them from MTN for production. Set:

```bash
MTN_COLLECTION_USER_ID=... MTN_COLLECTION_API_KEY=... MTN_COLLECTION_SUBSCRIPTION_KEY=...
MTN_DISBURSEMENT_USER_ID=... MTN_DISBURSEMENT_API_KEY=... MTN_DISBURSEMENT_SUBSCRIPTION_KEY=...
MTN_TARGET_ENVIRONMENT=sandbox        # production uses the value MTN gives you
MTN_CALLBACK_URL=https://<your-host>/webhooks/mtn?token=<MTN_CALLBACK_TOKEN>
MTN_CALLBACK_TOKEN=<long random value>
```

| | MTN API | Notes |
| --- | --- | --- |
| Token | `POST /{collection or disbursement}/token/` with Basic auth (API user : API key) | Cached until a minute before it expires |
| Every call | `Ocp-Apim-Subscription-Key`, `Authorization: Bearer`, `X-Target-Environment` | |
| Collection | `POST /collection/v1_0/requesttopay`, with our UUID as `X-Reference-Id` | `202` means accepted. `409 RESOURCE_ALREADY_EXIST` means an earlier try got through |
| Payout | `POST /disbursement/v1_0/transfer` | Same headers |
| Status | `GET /collection/v1_0/requesttopay/{referenceId}`, `GET /disbursement/v1_0/transfer/{referenceId}` | `PENDING`, `SUCCESSFUL`, `FAILED` with a `reason` code |
| Callback | `POST` to `X-Callback-Url` | Not signed: used only as a hint to check the status |

**Sources:** MTN MoMo developer portal, [API collections](https://momodeveloper.mtn.com/API-collections). The operations above (CreateAccessToken, RequesttoPay, RequesttoPayTransactionStatus, Transfer, GetTransferStatus) and the `RequestToPayResult`, `TransferResult` and `ErrorReason` schemas were read from the portal's own API definitions.

**Two things to confirm in MTN's sandbox before going live:**
- **Amount format.** MTN's schema types `amount` as a string without saying how decimals are written. We send `"25"` for a whole amount and `"10.50"` otherwise.
- **Currency.** MTN's sandbox only accepts EUR, which is why `MTN_CURRENCIES` defaults to EUR there. Production in Ghana is GHS.

## Sandbox: `sandbox`

Built in, with no money and no keys. See [sandbox.md](sandbox.md).

## Routing

Each network goes to one provider:
- **By default:** the first real provider that can serve that network, otherwise the sandbox.
- **With `ROUTES`:** whatever you set, e.g. `mtn=mtn_momo,telecel=paystack,airteltigo=paystack,mpesa=paystack`.
- **Per request:** a `provider` field overrides the route for that one request.

`GET /v1/routing` shows the current routes.

## Adding a provider

Implement the `Provider` interface in [`src/types.ts`](../src/types.ts):
- `supports`, `collect`, `payout` and `status`;
- `submitOtp`, if the provider uses OTPs.

Map the provider's statuses onto the five shared ones. Add a test against a fake server built from the provider's docs, and link those docs in the pull request.
