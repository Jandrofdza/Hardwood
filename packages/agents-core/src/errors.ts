export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "invalid_transition"
  | "agent_disabled"
  | "agent_killed"
  | "forbidden"
  | "policy_blocked"
  | "idempotency_conflict"
  | "concurrency_conflict"
  | "stale_approval"
  | "unsupported"
  | "secret_detected";

export class HardwoodError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HardwoodError";
  }
}

export const isHardwoodError = (e: unknown, code?: ErrorCode): e is HardwoodError =>
  e instanceof HardwoodError && (code === undefined || e.code === code);
