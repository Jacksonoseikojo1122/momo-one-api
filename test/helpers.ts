import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: any };

/** A tiny HTTP server for pretending to be MTN, Paystack or a merchant's webhook endpoint. */
export async function fakeServer(handler: (req: Seen) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const s: Seen = { method: req.method!, path: req.url!, headers: req.headers, body };
    seen.push(s);
    const out = await handler(s);
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(out.body === undefined ? "" : JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export class Clock {
  constructor(public t = Date.parse("2026-10-16T09:00:00Z")) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}
