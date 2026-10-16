// One shape for every provider. Money is always integer minor units (pesewas, cents).

export const NETWORKS = ["mtn", "telecel", "airteltigo", "mpesa"] as const;
export type Network = (typeof NETWORKS)[number];

export const CURRENCIES = ["GHS", "KES", "EUR"] as const; // EUR: MTN's sandbox only accepts EUR
export type Currency = (typeof CURRENCIES)[number];

export type Direction = "collection" | "payout";

/**
 * pending          sent to the provider, waiting for the customer or the network
 * action_required  the provider needs something more (e.g. an OTP) before it can continue
 * succeeded        money moved
 * failed           money didn't move
 * reversed         money moved, then the provider sent it back (payouts)
 */
export type Status = "pending" | "action_required" | "succeeded" | "failed" | "reversed";

export type FailureCode =
  | "declined" // the customer rejected or ignored the prompt
  | "insufficient_funds"
  | "expired"
  | "account_not_found"
  | "limit_reached"
  | "not_allowed"
  | "provider_error"
  | "unknown";

export type Payment = {
  id: string;
  direction: Direction;
  status: Status;
  amount: number;
  currency: Currency;
  phone: string; // international digits, e.g. 233241234567
  network: Network;
  provider: string;
  reference: string; // what we gave the provider; also how we look the payment up there
  provider_reference: string | null; // the provider's own id once known
  provider_status: string | null; // raw status from the provider, for debugging
  failure: { code: FailureCode; message: string } | null;
  action: { type: "otp"; message: string } | null;
  customer: { name?: string; email?: string };
  description: string | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

/** What a provider tells us about a payment. */
export type ProviderResult = {
  status: Status;
  providerStatus: string;
  providerReference?: string | null;
  failure?: { code: FailureCode; message: string } | null;
  action?: { type: "otp"; message: string } | null;
};

export interface Provider {
  readonly name: string;
  /** Can this provider handle this kind of payment? */
  supports(direction: Direction, network: Network, currency: Currency): boolean;
  collect(p: Payment): Promise<ProviderResult>;
  payout(p: Payment): Promise<ProviderResult>;
  /** Ask the provider for the current status. Always the source of truth. */
  status(p: Payment): Promise<ProviderResult>;
  submitOtp?(p: Payment, otp: string): Promise<ProviderResult>;
}

/** A provider call that may or may not have reached the provider (timeout, connection reset). */
export class ProviderUnreachable extends Error {}

/** The provider clearly refused the request (bad input, not allowed). Nothing was started. */
export class ProviderRejected extends Error {
  constructor(message: string, public code: FailureCode = "provider_error") {
    super(message);
  }
}
