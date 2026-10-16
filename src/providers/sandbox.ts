import type { Currency, Direction, Network, Payment, Provider, ProviderResult } from "../types.js";

/**
 * A pretend provider for building and testing without money or provider keys.
 * The last four digits of the phone number pick what happens:
 *
 *   ...0001  declined by the customer
 *   ...0002  insufficient funds
 *   ...0003  stays pending (to test stuck payments and reconciliation)
 *   ...0004  needs an OTP; 123456 is accepted
 *   ...0005  payout succeeds, then is reversed
 *   anything else  succeeds after SANDBOX_DELAY_MS (3 s by default)
 */
export class SandboxProvider implements Provider {
  readonly name = "sandbox";
  constructor(private delayMs = 3000, private now: () => number = Date.now) {}

  supports(_d: Direction, _n: Network, _c: Currency) {
    return true;
  }

  async collect(p: Payment) {
    return this.status(p);
  }
  async payout(p: Payment) {
    return this.status(p);
  }

  async submitOtp(p: Payment, otp: string): Promise<ProviderResult> {
    if (otp !== "123456") return { status: "action_required", providerStatus: "otp_rejected", action: { type: "otp", message: "Wrong code. The sandbox code is 123456." } };
    return { status: "succeeded", providerStatus: "otp_accepted", providerReference: "SBX-" + p.reference.slice(0, 8) };
  }

  async status(p: Payment): Promise<ProviderResult> {
    const age = this.now() - Date.parse(p.created_at);
    const due = age >= this.delayMs;
    const ref = "SBX-" + p.reference.slice(0, 8);
    switch (p.phone.slice(-4)) {
      case "0001":
        return due ? { status: "failed", providerStatus: "DECLINED", failure: { code: "declined", message: "The customer declined the request." } } : pending();
      case "0002":
        return due ? { status: "failed", providerStatus: "NOT_ENOUGH_FUNDS", failure: { code: "insufficient_funds", message: "Not enough money in the customer's wallet." } } : pending();
      case "0003":
        return pending();
      case "0004":
        if (p.provider_status === "otp_accepted") return { status: "succeeded", providerStatus: "otp_accepted", providerReference: ref };
        return { status: "action_required", providerStatus: "send_otp", action: { type: "otp", message: "Enter the code sent to the customer's phone (sandbox: 123456)." } };
      case "0005":
        if (p.direction === "payout" && age >= this.delayMs * 2) return { status: "reversed", providerStatus: "REVERSED", providerReference: ref };
        return due ? { status: "succeeded", providerStatus: "SUCCESSFUL", providerReference: ref } : pending();
      default:
        return due ? { status: "succeeded", providerStatus: "SUCCESSFUL", providerReference: ref } : pending();
    }
  }
}

const pending = (): ProviderResult => ({ status: "pending", providerStatus: "PENDING" });
