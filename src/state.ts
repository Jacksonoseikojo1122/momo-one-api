import type { Status } from "./types.js";

// The one state machine every provider is mapped onto.
//
//   pending ◀──▶ action_required      (either of these can move to any of the three below)
//      ├──▶ succeeded ──▶ reversed     (a payout the network sent back)
//      ├──▶ reversed                   (some providers report the reversal directly)
//      └──▶ failed
//
// failed and reversed are final. succeeded only moves to reversed.
const NEXT: Record<Status, Status[]> = {
  pending: ["action_required", "succeeded", "failed", "reversed"],
  action_required: ["pending", "succeeded", "failed", "reversed"],
  succeeded: ["reversed"],
  failed: [],
  reversed: [],
};

export function canMove(from: Status, to: Status): boolean {
  return NEXT[from].includes(to);
}

export function isFinal(s: Status): boolean {
  return s === "failed" || s === "reversed";
}

export function isOpen(s: Status): boolean {
  return s === "pending" || s === "action_required";
}
