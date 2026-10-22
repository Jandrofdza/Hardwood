import type { AuditEvent } from "../audit.js";
import type {
  Bill,
  BillerConnector,
  ChargeStatus,
  ConnectorMode,
  PaymentResult,
} from "../connector.js";
import { HardwoodError } from "../errors.js";
import type {
  ClaimResult,
  Clock,
  DomainEvent,
  EventSink,
  IdGenerator,
  Installation,
  PaymentRecord,
  Store,
} from "../ports.js";
import type { Approval, Run, RunState, RunStep } from "../run.js";

type Data = {
  installations: Map<string, Installation>;
  killSwitches: Set<string>;
  runs: Map<string, Run>;
  runKeys: Map<string, string>;
  steps: RunStep[];
  approvals: Map<string, Approval>;
  payments: Map<string, PaymentRecord>;
  audit: AuditEvent[];
};

const empty = (): Data => ({
  installations: new Map(),
  killSwitches: new Set(),
  runs: new Map(),
  runKeys: new Map(),
  steps: [],
  approvals: new Map(),
  payments: new Map(),
  audit: [],
});

const copy = <T>(v: T): T => structuredClone(v);

/**
 * Store with the same guarantees the Postgres store must give: unique keys, optimistic
 * versions, serialized transactions and rollback on error.
 */
export class InMemoryStore implements Store {
  private data = empty();
  private lock: Promise<unknown> = Promise.resolve();

  /** Transactions run one at a time. Not re-entrant: the engine never nests them. */
  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    const run = async () => {
      const snapshot = copy(this.data);
      try {
        return await fn(this);
      } catch (err) {
        this.data = snapshot;
        throw err;
      }
    };
    const result = this.lock.then(run, run);
    this.lock = result.catch(() => undefined);
    return result;
  }

  async getInstallation(workspaceId: string, agentId: string) {
    return copy(this.data.installations.get(`${workspaceId}/${agentId}`) ?? null);
  }
  async saveInstallation(i: Installation) {
    this.data.installations.set(`${i.workspaceId}/${i.agentId}`, copy(i));
  }
  async isKillSwitchOn(agentId: string) {
    return this.data.killSwitches.has(agentId);
  }
  async setKillSwitch(agentId: string, on: boolean) {
    if (on) this.data.killSwitches.add(agentId);
    else this.data.killSwitches.delete(agentId);
  }

  async insertRun(run: Run) {
    const key = `${run.workspaceId}/${run.idempotencyKey}`;
    const existingId = this.data.runKeys.get(key);
    const existing = existingId ? this.data.runs.get(existingId) : undefined;
    if (existing) return { inserted: false as const, existing: copy(existing) };
    this.data.runs.set(run.id, copy(run));
    this.data.runKeys.set(key, run.id);
    return { inserted: true as const };
  }
  async getRun(id: string) {
    return copy(this.data.runs.get(id) ?? null);
  }
  async updateRun(run: Run) {
    const current = this.data.runs.get(run.id);
    if (!current) throw new HardwoodError("not_found", `run ${run.id} not found`);
    if (current.version !== run.version - 1) {
      throw new HardwoodError("concurrency_conflict", `run ${run.id} version mismatch`);
    }
    this.data.runs.set(run.id, copy(run));
  }
  async listRuns(filter: { agentId: string; workspaceId?: string; states: RunState[] }) {
    return [...this.data.runs.values()]
      .filter(
        (r) =>
          r.agentId === filter.agentId &&
          (filter.workspaceId === undefined || r.workspaceId === filter.workspaceId) &&
          filter.states.includes(r.state),
      )
      .map(copy);
  }
  async addStep(step: RunStep) {
    this.data.steps.push(copy(step));
  }
  async listSteps(runId: string) {
    return this.data.steps.filter((s) => s.runId === runId).map(copy);
  }

  async saveApproval(a: Approval) {
    this.data.approvals.set(a.id, copy(a));
  }
  async getApproval(id: string) {
    return copy(this.data.approvals.get(id) ?? null);
  }

  async claimPayment(record: PaymentRecord): Promise<ClaimResult> {
    const existing = this.data.payments.get(record.paymentKey);
    if (existing && existing.status !== "failed")
      return { claimed: false, existing: copy(existing) };
    this.data.payments.set(record.paymentKey, copy(record));
    return { claimed: true };
  }
  async updatePayment(record: PaymentRecord) {
    this.data.payments.set(record.paymentKey, copy(record));
  }
  async getPayment(key: string) {
    return copy(this.data.payments.get(key) ?? null);
  }
  async committedCents(workspaceId: string, agentId: string, from: Date, to: Date) {
    let sum = 0;
    for (const p of this.data.payments.values()) {
      const at = new Date(p.claimedAt);
      if (
        p.workspaceId === workspaceId &&
        p.agentId === agentId &&
        p.status !== "failed" &&
        at >= from &&
        at < to
      ) {
        sum += p.amountCents;
      }
    }
    return sum;
  }

  async lastAuditEvent() {
    return copy(this.data.audit.at(-1) ?? null);
  }
  async appendAuditEvent(e: AuditEvent) {
    const last = this.data.audit.at(-1);
    if (e.seq !== (last ? last.seq + 1 : 1)) {
      throw new HardwoodError("concurrency_conflict", "audit sequence conflict");
    }
    this.data.audit.push(copy(e));
  }

  /** Test helpers. */
  auditLog(): AuditEvent[] {
    return copy(this.data.audit);
  }
  /** Tamper with the log, to test verification. */
  unsafeAuditLog(): AuditEvent[] {
    return this.data.audit;
  }
}

export class FakeClock implements Clock {
  private t: number;
  constructor(start = "2026-10-15T18:00:00Z") {
    this.t = new Date(start).getTime();
  }
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
  set(iso: string) {
    this.t = new Date(iso).getTime();
  }
}

export class CollectingEventSink implements EventSink {
  readonly events: DomainEvent[] = [];
  async emit(e: DomainEvent) {
    this.events.push(e);
  }
  types() {
    return this.events.map((e) => e.type);
  }
}

export function sequentialIds(prefix = "id"): IdGenerator {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

type PayScript = PaymentResult["status"] | "throw";

/**
 * A connector whose behaviour each test scripts: what lookup returns next, how each
 * payment attempt ends, and what a later reconciliation finds. Counts real charges.
 */
export class ScriptedConnector implements BillerConnector {
  readonly mode: ConnectorMode = "mock";
  bill: Bill | null;
  payScript: PayScript[] = ["paid"];
  checkScript: ChargeStatus["status"][] = [];
  payCalls = 0;
  /** Idempotency keys actually charged. */
  readonly charged = new Map<string, number>();

  constructor(
    readonly billerId: string,
    bill: Bill | null,
  ) {
    this.bill = bill;
  }

  validateAccountRef(ref: string) {
    return /^\d{6,20}$/.test(ref);
  }

  async lookup(accountRef: string) {
    return this.bill && this.bill.accountRef === accountRef ? { ...this.bill } : null;
  }

  async pay(bill: Bill, key: string): Promise<PaymentResult> {
    this.payCalls++;
    const step = this.payScript.shift() ?? "paid";
    if (step === "throw") throw new Error("socket hang up");
    if (step === "declined") return { status: "declined", reason: "insufficient funds" };
    // "paid" and "unknown" both charge; unknown just loses the response.
    this.charged.set(key, (this.charged.get(key) ?? 0) + 1);
    if (step === "unknown") return { status: "unknown", reason: "timeout" };
    return {
      status: "paid",
      folio: `SIM-${this.payCalls}`,
      amountCents: bill.amountCents,
      paidAt: "2026-10-15T18:00:00.000Z",
    };
  }

  async checkPayment(key: string): Promise<ChargeStatus> {
    const scripted = this.checkScript.shift();
    if (scripted) {
      if (scripted === "charged") {
        return {
          status: "charged",
          folio: "SIM-RECONCILED",
          amountCents: this.bill?.amountCents ?? 0,
          paidAt: "2026-10-15T18:00:00.000Z",
        };
      }
      return { status: scripted };
    }
    return this.charged.has(key)
      ? {
          status: "charged",
          folio: "SIM-RECONCILED",
          amountCents: this.bill?.amountCents ?? 0,
          paidAt: "2026-10-15T18:00:00.000Z",
        }
      : { status: "not_charged" };
  }
}
