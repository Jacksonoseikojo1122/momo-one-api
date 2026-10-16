import { ProviderUnreachable } from "../types.js";

export type HttpResult = { status: number; body: any; text: string };

/**
 * fetch with a timeout. Network errors and timeouts become ProviderUnreachable: the
 * request may or may not have reached the provider, so the payment stays pending and
 * the reconciler asks the provider later, using our own reference.
 */
export async function call(url: string, init: RequestInit & { timeoutMs?: number }): Promise<HttpResult> {
  const { timeoutMs = 15_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ProviderUnreachable(`${new URL(url).host}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

/** 1050 -> "10.50", 1000 -> "10" */
export function major(minor: number): string {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

/** How long since the payment was created, in ms. */
export function ageMs(createdAt: string): number {
  return Date.now() - Date.parse(createdAt);
}
