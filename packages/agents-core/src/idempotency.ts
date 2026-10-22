import { canonicalJson, sha256 } from "./canonical.js";
import { HardwoodError } from "./errors.js";

export type BillIdentity = {
  workspaceId: string;
  billerId: string;
  accountRef: string;
  period: string;
};

/** The key that makes a bill payable at most once. */
export function paymentKey(b: BillIdentity): string {
  for (const [k, v] of Object.entries(b)) {
    if (!v.trim()) throw new HardwoodError("invalid_input", `${k} is required for a payment key`);
  }
  return ["pay", b.workspaceId, b.billerId, b.accountRef, b.period]
    .map(encodeURIComponent)
    .join(":");
}

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;

export function assertIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new HardwoodError(
      "invalid_input",
      "idempotency key must be 8-200 characters of letters, digits, _ . : -",
    );
  }
}

export const requestHash = (agentId: string, action: string, input: unknown) =>
  sha256(canonicalJson({ agentId, action, input }));
