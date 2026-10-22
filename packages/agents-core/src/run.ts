import { HardwoodError } from "./errors.js";
import type { Cents, Currency } from "./money.js";

export const RUN_STATES = [
  "queued",
  "running",
  "awaiting_approval",
  "executing",
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
]);
export const isTerminal = (s: RunState) => TERMINAL_STATES.has(s);

export const RUN_EVENTS = [
  "start",
  "propose",
  "complete",
  "approve",
  "reject",
  "amount_changed",
  "succeed",
  "fail",
  "cancel",
] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];

/**
 * The whole lifecycle. Anything not listed is an invalid transition.
 *
 * queued → running → awaiting_approval ──approve──→ executing → succeeded
 *                  │                  └──reject───→ rejected
 *                  ├─(read action done)→ succeeded
 *                  └─(error / no bill)→ failed
 * queued | running | awaiting_approval ──cancel──→ cancelled
 * awaiting_approval | executing ──amount_changed──→ awaiting_approval (new approval)
 *
 * `executing` cannot be cancelled: a charge may be in flight. It ends in succeeded or
 * failed, the latter only once the connector confirms nothing was charged.
 */
export const TRANSITIONS: Readonly<Record<RunState, Partial<Record<RunEvent, RunState>>>> = {
  queued: { start: "running", cancel: "cancelled" },
  running: {
    propose: "awaiting_approval",
    complete: "succeeded",
    fail: "failed",
    cancel: "cancelled",
  },
  awaiting_approval: {
    approve: "executing",
    reject: "rejected",
    amount_changed: "awaiting_approval",
    cancel: "cancelled",
  },
  executing: { succeed: "succeeded", fail: "failed", amount_changed: "awaiting_approval" },
  succeeded: {},
  failed: {},
  rejected: {},
  cancelled: {},
};

export function nextState(from: RunState, event: RunEvent): RunState {
  const to = TRANSITIONS[from][event];
  if (!to) {
    throw new HardwoodError("invalid_transition", `cannot ${event} a run that is ${from}`, {
      from,
      event,
    });
  }
  return to;
}

export const canTransition = (from: RunState, event: RunEvent) =>
  TRANSITIONS[from][event] !== undefined;

export type ActorType = "user" | "agent" | "system" | "host";
/** Who did something. `ref` is an opaque id from the host, never personal data. */
export type Actor = { type: ActorType; ref?: string | undefined };

export type RunRequester = "user" | "agent" | "schedule" | "host";

export type PaymentProposal = {
  billerId: string;
  accountRef: string;
  period: string;
  amountCents: Cents;
  currency: Currency;
  dueDate: string;
  paymentReference?: string | undefined;
  /** Unique per bill: (workspaceId, billerId, accountRef, period). */
  paymentKey: string;
};

export type Run = {
  id: string;
  workspaceId: string;
  agentId: string;
  action: string;
  input: unknown;
  state: RunState;
  idempotencyKey: string;
  /** Hash of agent + action + input, to reject a reused key with a different request. */
  requestHash: string;
  requestedBy: RunRequester;
  requestedByRef?: string | undefined;
  proposal?: PaymentProposal | undefined;
  approvalId?: string | undefined;
  /** Set when a payment outcome is unknown and must be checked with the connector. */
  reconciliation?: "pending" | undefined;
  output?: unknown;
  error?: { code: string; message: string } | undefined;
  /** Optimistic concurrency: bumped on every write. */
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RunStep = {
  runId: string;
  at: string;
  kind: string;
  /** Human-readable, shown in the console's live step log. */
  message: string;
  data?: Record<string, unknown> | undefined;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "superseded";

/** An approval is bound to one amount. A new amount needs a new approval. */
export type Approval = {
  id: string;
  runId: string;
  amountCents: Cents;
  currency: Currency;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string | undefined;
  decidedBy?: string | undefined;
  comment?: string | undefined;
};
