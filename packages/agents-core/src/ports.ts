import type { AuditEvent } from "./audit.js";
import type { Cents, Currency } from "./money.js";
import type { Policy } from "./policy.js";
import type { Approval, Run, RunState, RunStep } from "./run.js";

export type Installation = {
  workspaceId: string;
  agentId: string;
  enabled: boolean;
  settings: unknown;
  policy: Policy;
  updatedAt: string;
};

export type PaymentStatus = "pending" | "paid" | "failed" | "unknown";

/** One row per bill, keyed by `paymentKey` (unique). Claimed before any money moves. */
export type PaymentRecord = {
  paymentKey: string;
  runId: string;
  workspaceId: string;
  agentId: string;
  amountCents: Cents;
  currency: Currency;
  status: PaymentStatus;
  claimedAt: string;
  folio?: string | undefined;
  paidAt?: string | undefined;
  receiptUrl?: string | undefined;
};

export type ClaimResult = { claimed: true } | { claimed: false; existing: PaymentRecord };

/**
 * Persistence port. The API implements it on Postgres; tests use `InMemoryStore`.
 * Uniqueness the store must enforce: run (workspaceId, idempotencyKey), payment paymentKey,
 * installation (workspaceId, agentId), audit seq.
 */
export interface Store {
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;

  getInstallation(workspaceId: string, agentId: string): Promise<Installation | null>;
  saveInstallation(installation: Installation): Promise<void>;
  isKillSwitchOn(agentId: string): Promise<boolean>;
  setKillSwitch(agentId: string, on: boolean): Promise<void>;

  /** Returns the existing run instead of inserting when (workspaceId, idempotencyKey) exists. */
  insertRun(run: Run): Promise<{ inserted: true } | { inserted: false; existing: Run }>;
  getRun(id: string): Promise<Run | null>;
  /** Throws `concurrency_conflict` unless the stored version is `run.version - 1`. */
  updateRun(run: Run): Promise<void>;
  listRuns(filter: { agentId: string; workspaceId?: string; states: RunState[] }): Promise<Run[]>;
  addStep(step: RunStep): Promise<void>;
  listSteps(runId: string): Promise<RunStep[]>;

  saveApproval(approval: Approval): Promise<void>;
  getApproval(id: string): Promise<Approval | null>;

  /** Insert, or take over a row whose status is `failed`. Otherwise report the holder. */
  claimPayment(record: PaymentRecord): Promise<ClaimResult>;
  updatePayment(record: PaymentRecord): Promise<void>;
  getPayment(paymentKey: string): Promise<PaymentRecord | null>;
  /** Sum of non-failed payments claimed in [from, to). */
  committedCents(workspaceId: string, agentId: string, from: Date, to: Date): Promise<Cents>;

  lastAuditEvent(): Promise<AuditEvent | null>;
  appendAuditEvent(event: AuditEvent): Promise<void>;
}

export type WebhookEventType =
  | "run.queued"
  | "run.running"
  | "run.awaiting_approval"
  | "run.executing"
  | "run.succeeded"
  | "run.failed"
  | "run.rejected"
  | "run.cancelled"
  | "bill.found";

export type DomainEvent = {
  type: WebhookEventType;
  workspaceId: string;
  runId: string;
  at: string;
  data: Record<string, unknown>;
};

/** Delivered to hosts as signed webhooks by the API (Phase 3). */
export interface EventSink {
  emit(event: DomainEvent): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export type IdGenerator = () => string;
