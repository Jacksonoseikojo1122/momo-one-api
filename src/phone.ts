import type { Network } from "./types.js";

/**
 * Normalises a phone number to international digits (233241234567, 254712345678).
 * Ghana networks expect Ghanaian numbers; M-Pesa expects Kenyan ones.
 *
 * The network has to be given: numbers move between networks in Ghana (number
 * portability), so the prefix doesn't reliably say which network a customer is on.
 */
export function normalisePhone(input: string, network: Network): string | null {
  const digits = input.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;
  const [cc, localLen] = network === "mpesa" ? ["254", 9] : ["233", 9];
  let local: string;
  if (digits.startsWith(cc) && digits.length === cc.length + localLen) local = digits.slice(cc.length);
  else if (digits.startsWith("0") && digits.length === localLen + 1) local = digits.slice(1);
  else if (digits.length === localLen) local = digits;
  else return null;
  if (local.startsWith("0")) return null;
  return cc + local;
}

/** 233241234567 -> 0241234567 (the form Paystack's Ghana examples use). */
export function localFormat(international: string): string {
  return "0" + international.slice(3);
}
