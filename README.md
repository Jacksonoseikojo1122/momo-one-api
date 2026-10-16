# MoMo One-API

One clean API and one webhook format across MTN MoMo, Telecel Cash, AirtelTigo Money and M-Pesa.

> **Status: in development.** I'm building this in public. Follow along here or on the project page:
> **https://jacksonkojoosei.com/projects/momo-one-api**

## What it does

A routing layer over licensed payment providers, so developers write one integration instead of four. It never holds money: payments go straight through the licensed provider, and the API normalises requests, statuses and webhooks.

## Why

Every mobile-money network and aggregator has its own API, its own statuses and its own webhook shape. Switching or adding one means rewriting the payment code.

## Planned features

- [ ] One request format for collections and payouts
- [ ] One payment state machine across providers
- [ ] Normalised webhooks, delivered through Webhook Relay
- [ ] Daily reconciliation against the provider's records
- [ ] Sandbox mode for testing without real money

## Stack

TypeScript, Go, PostgreSQL, Redis Streams

## Author

Built by **[Jackson Kojo Osei](https://jacksonkojoosei.com)**, CTO in Accra, Ghana.
[LinkedIn](https://www.linkedin.com/in/jackson-kojo-osei-740846189) · [All projects](https://jacksonkojoosei.com/projects)

## License

MIT
