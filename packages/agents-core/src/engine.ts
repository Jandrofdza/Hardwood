import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AuditInput } from "./audit.js";
import { createAuditEvent } from "./audit.js";
import type { Bill, BillerConnector, ChargeStatus, PaymentResult } from "./connector.js";
import { HardwoodError } from "./errors.js";
import { assertIdempotencyKey, paymentKey, requestHash } from "./idempotency.js";
import type { AgentManifest } from "./manifest.js";
import { defineAgent, findAction } from "./manifest.js";
import { centsSchema } from "./money.js";
import type { Policy } from "./policy.js";
import { canApprove, evaluatePayment, mexicoCityMonth, policySchema } from "./policy.js";
import type {
  Clock,
  DomainEvent,
  EventSink,
  IdGenerator,
  Installation,
  PaymentRecord,
  Store,
  WebhookEventType,
} from "./ports.js";
import type { Actor, Approval, Run, RunEvent, RunRequester, RunState, RunStep } from "./run.js";
import { canTransition, nextState } from "./run.js";
import { assertNoSecrets } from "./secrets.js";

export type EngineDeps = {
  store: Store;
  events: EventSink;
  agents: AgentManifest[];
  clock?: Clock;
  ids?: IdGenerator;
};

export type RunRequest = {
  workspaceId: string;
  agentId: string;
  action: string;
  input: unknown;
  idempotencyKey: string;
  requestedBy: RunRequester;
  requestedByRef?: string | undefined;
};

export type ApprovalDecision = {
  approvalId: string;
  /** Opaque user ref from the host. */
  decidedBy: string;
  /** The decider's roles, as asserted by the host. Checked against the policy. */
  roles: string[];
  comment?: string | undefined;
};

export type ExecuteOutcome =
  "succeeded" | "failed" | "awaiting_approval" | "reconciliation_pending";

/** States a disabled add-in or the kill switch cancels. `executing` finishes on its own. */
const CANCELLABLE: RunState[] = ["queued", "running", "awaiting_approval"];

type Ctx = { store: Store; emit: (e: DomainEvent) => void };

const SYSTEM: Actor = { type: "system" };

/**
 * Runs agents' actions through the lifecycle in run.ts. This is the only code that
 * calls a connector's `pay`, and only for a run whose current approval is approved.
 * LLM-facing code gets `requestRun` and read methods; nothing here takes a model's word
 * for an approval.
 */
export class AgentEngine {
  private readonly store: Store;
  private readonly events: EventSink;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly agents = new Map<string, AgentManifest>();

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.ids = deps.ids ?? randomUUID;
    for (const m of deps.agents) {
      if (this.agents.has(m.id))
        throw new HardwoodError("invalid_input", `duplicate agent ${m.id}`);
      this.agents.set(m.id, defineAgent(m));
    }
  }

  catalog(): AgentManifest[] {
    return [...this.agents.values()];
  }

  // -- installations ---------------------------------------------------------

  async installAgent(
    workspaceId: string,
    agentId: string,
    config: { settings: unknown; policy: unknown; enabled?: boolean },
    actor: Actor,
  ): Promise<Installation> {
    const manifest = this.manifest(agentId);
    const settings = parse(manifest.settingsSchema, config.settings, "settings");
    const policy: Policy = parse(policySchema, config.policy, "policy");
    assertNoSecrets(settings);
    const installation: Installation = {
      workspaceId,
      agentId,
      enabled: config.enabled ?? true,
      settings,
      policy,
      updatedAt: this.now(),
    };
    return this.tx(async (ctx) => {
      await ctx.store.saveInstallation(installation);
      await this.audit(ctx, {
        actor,
        entity: { type: "installation", id: `${workspaceId}/${agentId}` },
        action: "installation.saved",
        payload: { enabled: installation.enabled, settings, policy },
      });
      if (!installation.enabled) {
        await this.cancelActive(ctx, { agentId, workspaceId }, actor, "add-in turned off");
      }
      return installation;
    });
  }

  /** Off means off: turning an add-in off cancels its queued and waiting runs. */
  async setEnabled(
    workspaceId: string,
    agentId: string,
    enabled: boolean,
    actor: Actor,
  ): Promise<Installation> {
    return this.tx(async (ctx) => {
      const current = await ctx.store.getInstallation(workspaceId, agentId);
      if (!current) throw new HardwoodError("not_found", `${agentId} is not installed`);
      const next = { ...current, enabled, updatedAt: this.now() };
      await ctx.store.saveInstallation(next);
      await this.audit(ctx, {
        actor,
        entity: { type: "installation", id: `${workspaceId}/${agentId}` },
        action: enabled ? "installation.enabled" : "installation.disabled",
      });
      if (!enabled) {
        await this.cancelActive(ctx, { agentId, workspaceId }, actor, "add-in turned off");
      }
      return next;
    });
  }

  /** Global switch: on disables the agent for every workspace. */
  async setKillSwitch(agentId: string, on: boolean, actor: Actor): Promise<void> {
    this.manifest(agentId);
    await this.tx(async (ctx) => {
      await ctx.store.setKillSwitch(agentId, on);
      await this.audit(ctx, {
        actor,
        entity: { type: "agent", id: agentId },
        action: on ? "kill_switch.on" : "kill_switch.off",
      });
      if (on) await this.cancelActive(ctx, { agentId }, actor, "agent kill switch");
    });
  }

  // -- runs ------------------------------------------------------------------

  /**
   * Create a run, or return the existing one for the same idempotency key. Reusing a
   * key for a different request is an error.
   */
  async requestRun(req: RunRequest): Promise<{ run: Run; created: boolean }> {
    assertIdempotencyKey(req.idempotencyKey);
    const manifest = this.manifest(req.agentId);
    const action = findAction(manifest, req.action);
    if (!action) {
      throw new HardwoodError("not_found", `${req.agentId} has no action ${req.action}`);
    }
    const input = parse(action.input, req.input, "input");
    assertNoSecrets(input);
    const hash = requestHash(req.agentId, req.action, input);
    const now = this.now();
    const run: Run = {
      id: this.ids(),
      workspaceId: req.workspaceId,
      agentId: req.agentId,
      action: req.action,
      input,
      state: "queued",
      idempotencyKey: req.idempotencyKey,
      requestHash: hash,
      requestedBy: req.requestedBy,
      requestedByRef: req.requestedByRef,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    return this.tx(async (ctx) => {
      await this.assertAgentAvailable(ctx.store, req.workspaceId, req.agentId);
      const res = await ctx.store.insertRun(run);
      if (!res.inserted) {
        if (res.existing.requestHash !== hash) {
          throw new HardwoodError(
            "idempotency_conflict",
            "idempotency key was already used for a different request",
            { runId: res.existing.id },
          );
        }
        return { run: res.existing, created: false };
      }
      const actor: Actor = { type: requesterActor(req.requestedBy), ref: req.requestedByRef };
      await this.step(ctx, run, "queued", `Requested ${req.action}`);
      await this.audit(ctx, {
        actor,
        entity: { type: "run", id: run.id },
        action: "run.requested",
        payload: { agentId: run.agentId, action: run.action, input },
      });
      ctx.emit(this.event("run.queued", run, { action: run.action }));
      return { run, created: true };
    });
  }

  async startRun(runId: string): Promise<Run> {
    return this.tx(async (ctx) => {
      const run = await this.load(ctx.store, runId);
      await this.assertAgentAvailable(ctx.store, run.workspaceId, run.agentId);
      return this.move(ctx, run, "start", SYSTEM, "Started");
    });
  }

  /** Finish a read-only action. Payment actions can only finish through `execute`. */
  async completeRun(runId: string, output: Record<string, unknown>): Promise<Run> {
    assertNoSecrets(output);
    return this.tx(async (ctx) => {
      const run = await this.load(ctx.store, runId);
      if (this.effect(run) !== "read") {
        throw new HardwoodError("invalid_transition", "payment runs finish through execute");
      }
      return this.move(ctx, run, "complete", this.agentActor(run), "Done", { output }, { output });
    });
  }

  async failRun(runId: string, error: { code: string; message: string }): Promise<Run> {
    return this.tx(async (ctx) => {
      const run = await this.load(ctx.store, runId);
      if (run.state === "executing") await this.assertNothingInFlight(ctx.store, run);
      return this.fail(ctx, run, this.agentActor(run), error);
    });
  }

  async cancel(runId: string, actor: Actor, reason = "cancelled"): Promise<Run> {
    return this.tx(async (ctx) => {
      const run = await this.load(ctx.store, runId);
      return this.cancelRun(ctx, run, actor, reason);
    });
  }

  /** The agent found the bill for a payment run: ask a human to approve it. */
  async proposePayment(runId: string, bill: Bill): Promise<Run> {
    parse(centsSchema.positive(), bill.amountCents, "bill amount");
    return this.tx(async (ctx) => {
      const run = await this.load(ctx.store, runId);
      if (this.effect(run) !== "payment") {
        throw new HardwoodError("invalid_transition", `${run.action} is not a payment action`);
      }
      if (!canTransition(run.state, "propose")) nextState(run.state, "propose");
      const actor = this.agentActor(run);
      const key = paymentKey({
        workspaceId: run.workspaceId,
        billerId: bill.billerId,
        accountRef: bill.accountRef,
        period: bill.period,
      });

      const existing = await ctx.store.getPayment(key);
      if (existing && existing.status !== "failed") {
        return this.fail(ctx, run, actor, {
          code: existing.status === "paid" ? "already_paid" : "payment_in_progress",
          message: `bill ${bill.period} is ${existing.status === "paid" ? "already paid" : "being paid by another run"}`,
        });
      }
      const blocked = await this.capCheck(ctx.store, run, bill.amountCents);
      if (blocked) return this.fail(ctx, run, actor, blocked);

      const proposal = {
        billerId: bill.billerId,
        accountRef: bill.accountRef,
        period: bill.period,
        amountCents: bill.amountCents,
        currency: bill.currency,
        dueDate: bill.dueDate,
        paymentReference: bill.paymentReference,
        paymentKey: key,
      };
      const approval = await this.newApproval(ctx, run, bill.amountCents, bill.currency, actor);
      ctx.emit(this.event("bill.found", run, { bill: proposal }));
      return this.move(
        ctx,
        run,
        "propose",
        actor,
        `Found ${bill.billerId} bill for ${bill.period}; waiting for approval`,
        { proposal, approvalId: approval.id },
        { amountCents: bill.amountCents, period: bill.period, approvalId: approval.id },
      );
    });
  }

  async approve(runId: string, d: ApprovalDecision): Promise<Run> {
    return this.tx(async (ctx) => {
      const run = await this.load(ctx.store, runId);
      if (!canTransition(run.state, "approve")) nextState(run.state, "approve");
      const inst = await this.assertAgentAvailable(ctx.store, run.workspaceId, run.agentId);
      if (!canApprove(inst.policy, d.roles)) {
        throw new HardwoodError("forbidden", "approver lacks a required role");
      }
      const approval = await this.currentApproval(ctx.store, run, d.approvalId);
      const blocked = await this.capCheck(ctx.store, run, approval.amountCents);
      if (blocked) throw new HardwoodError("policy_blocked", blocked.message);

      const actor: Actor = { type: "user", ref: d.decidedBy };
      await this.decide(ctx, approval, "approved", d, actor);
      return this.move(ctx, run, "approve", actor, "Approved", undefined, {
        approvalId: approval.id,
      });
    });
  }

  async reject(runId: string, d: ApprovalDecision): Promise<Run> {
    return this.tx(async (ctx) => {
      const run = await this.load(ctx.store, runId);
      if (!canTransition(run.state, "reject")) nextState(run.state, "reject");
      const inst = await ctx.store.getInstallation(run.workspaceId, run.agentId);
      if (!inst || !canApprove(inst.policy, d.roles)) {
        throw new HardwoodError("forbidden", "approver lacks a required role");
      }
      const approval = await this.currentApproval(ctx.store, run, d.approvalId);
      const actor: Actor = { type: "user", ref: d.decidedBy };
      await this.decide(ctx, approval, "rejected", d, actor);
      return this.move(ctx, run, "reject", actor, "Rejected", undefined, {
        approvalId: approval.id,
      });
    });
  }

  /**
   * Pay an approved run. Re-checks the bill first; a changed amount sends the run back
   * for a new approval. The payment key is claimed before the connector is called, so a
   * bill is charged at most once even under retries or concurrent calls.
   */
  async execute(runId: string, connector: BillerConnector): Promise<ExecuteOutcome> {
    const snapshot = await this.tx(async (ctx) => {
      const run = await this.load(ctx.store, runId);
      if (run.state !== "executing") {
        throw new HardwoodError("invalid_transition", `cannot execute a run that is ${run.state}`);
      }
      if (run.reconciliation === "pending") {
        throw new HardwoodError("invalid_transition", "payment outcome unknown; reconcile first");
      }
      const proposal = requireProposal(run);
      if (connector.billerId !== proposal.billerId) {
        throw new HardwoodError("invalid_input", "connector does not match the bill's biller");
      }
      if (!connector.pay) {
        throw new HardwoodError("unsupported", `${connector.mode} connector cannot pay`);
      }
      const approval = await ctx.store.getApproval(run.approvalId ?? "");
      if (approval?.status !== "approved" || approval.amountCents !== proposal.amountCents) {
        throw new HardwoodError("stale_approval", "run has no approval for this amount");
      }
      return run;
    });
    const proposal = requireProposal(snapshot);

    const fresh = await connector.lookup(proposal.accountRef);

    const claimed = await this.tx(async (ctx) => {
      const run = await this.loadVersion(ctx.store, runId, snapshot.version);
      const actor = this.agentActor(run);
      if (!fresh || fresh.period !== proposal.period) {
        await this.fail(ctx, run, actor, {
          code: "bill_not_found",
          message: "the approved bill is no longer open",
        });
        return null;
      }
      if (fresh.amountCents !== proposal.amountCents) {
        await this.amountChanged(ctx, run, fresh, actor);
        return null;
      }
      const record: PaymentRecord = {
        paymentKey: proposal.paymentKey,
        runId: run.id,
        workspaceId: run.workspaceId,
        agentId: run.agentId,
        amountCents: proposal.amountCents,
        currency: proposal.currency,
        status: "pending",
        claimedAt: this.now(),
      };
      const claim = await ctx.store.claimPayment(record);
      if (!claim.claimed) {
        if (claim.existing.runId === run.id) {
          // A previous attempt of this run claimed it and never finished: never pay twice.
          await this.markReconcile(ctx, run, "Previous attempt did not finish; reconciling");
          return null;
        }
        await this.fail(ctx, run, actor, {
          code: claim.existing.status === "paid" ? "already_paid" : "duplicate_payment",
          message: "another run holds this bill's payment",
        });
        return null;
      }
      await this.audit(ctx, {
        actor: SYSTEM,
        entity: { type: "payment", id: record.paymentKey },
        action: "payment.claimed",
        payload: { runId: run.id, amountCents: record.amountCents },
      });
      const touched = await this.touch(ctx, run, {}, "payment.started", "Paying");
      return { run: touched, record, bill: fresh };
    });
    if (!claimed) return this.outcome(runId);

    let result: PaymentResult;
    try {
      if (!connector.pay) throw new Error("connector cannot pay");
      result = await connector.pay(claimed.bill, proposal.paymentKey);
    } catch (err) {
      result = { status: "unknown", reason: err instanceof Error ? err.message : "error" };
    }

    await this.tx(async (ctx) => {
      const run = await this.loadVersion(ctx.store, runId, claimed.run.version);
      await this.settle(ctx, run, claimed.record, result);
    });
    return this.outcome(runId);
  }

  /** Resolve an unknown payment outcome by asking the connector what happened. */
  async reconcile(runId: string, connector: BillerConnector): Promise<ExecuteOutcome> {
    const snapshot = await this.tx(async (ctx) => {
      const run = await this.load(ctx.store, runId);
      if (run.state !== "executing" || run.reconciliation !== "pending") {
        throw new HardwoodError("invalid_transition", "run is not waiting for reconciliation");
      }
      if (!connector.checkPayment) {
        throw new HardwoodError("unsupported", `${connector.mode} connector cannot check payments`);
      }
      return run;
    });
    const proposal = requireProposal(snapshot);
    let status: ChargeStatus;
    try {
      if (!connector.checkPayment) throw new Error("connector cannot check payments");
      status = await connector.checkPayment(proposal.paymentKey);
    } catch {
      status = { status: "unknown" };
    }

    await this.tx(async (ctx) => {
      const run = await this.loadVersion(ctx.store, runId, snapshot.version);
      const record = await ctx.store.getPayment(proposal.paymentKey);
      if (!record || record.runId !== run.id) {
        throw new HardwoodError("not_found", "no payment claim for this run");
      }
      const result: PaymentResult =
        status.status === "charged"
          ? { ...status, status: "paid" }
          : status.status === "not_charged"
            ? { status: "declined", reason: "connector confirmed no charge" }
            : { status: "unknown", reason: "still unknown" };
      await this.settle(ctx, run, record, result);
    });
    return this.outcome(runId);
  }

  /** Re-check an open bill while waiting for approval (e.g. from a daily job). */
  async refreshProposal(runId: string, connector: BillerConnector): Promise<Run> {
    const run = await this.load(this.store, runId);
    if (run.state !== "awaiting_approval") return run;
    const proposal = requireProposal(run);
    const fresh = await connector.lookup(proposal.accountRef);
    return this.tx(async (ctx) => {
      const current = await this.loadVersion(ctx.store, runId, run.version);
      if (fresh && fresh.period === proposal.period && fresh.amountCents !== proposal.amountCents) {
        return this.amountChanged(ctx, current, fresh, this.agentActor(current));
      }
      return current;
    });
  }

  async getRun(runId: string): Promise<{ run: Run; steps: RunStep[]; approval: Approval | null }> {
    const run = await this.load(this.store, runId);
    return {
      run,
      steps: await this.store.listSteps(runId),
      approval: run.approvalId ? await this.store.getApproval(run.approvalId) : null,
    };
  }

  // -- internals -------------------------------------------------------------

  private async settle(ctx: Ctx, run: Run, record: PaymentRecord, result: PaymentResult) {
    const actor = this.agentActor(run);
    const clear = { reconciliation: undefined };
    if (result.status === "paid") {
      await ctx.store.updatePayment({
        ...record,
        status: "paid",
        folio: result.folio,
        paidAt: result.paidAt,
        receiptUrl: result.receiptUrl,
      });
      await this.audit(ctx, {
        actor: SYSTEM,
        entity: { type: "payment", id: record.paymentKey },
        action: "payment.paid",
        payload: { runId: run.id, folio: result.folio, amountCents: result.amountCents },
      });
      const mismatch = result.amountCents !== record.amountCents;
      const output = {
        folio: result.folio,
        amountCents: result.amountCents,
        paidAt: result.paidAt,
      };
      await this.move(
        ctx,
        run,
        "succeed",
        actor,
        mismatch
          ? "Paid, but the charged amount differs from the approval"
          : `Paid, folio ${result.folio}`,
        { ...clear, output },
        mismatch ? { ...output, approvedCents: record.amountCents, amountMismatch: true } : output,
      );
    } else if (result.status === "declined") {
      await ctx.store.updatePayment({ ...record, status: "failed" });
      await this.audit(ctx, {
        actor: SYSTEM,
        entity: { type: "payment", id: record.paymentKey },
        action: "payment.failed",
        payload: { runId: run.id, reason: result.reason },
      });
      await this.fail(ctx, run, actor, { code: "payment_declined", message: result.reason }, clear);
    } else {
      await ctx.store.updatePayment({ ...record, status: "unknown" });
      await this.audit(ctx, {
        actor: SYSTEM,
        entity: { type: "payment", id: record.paymentKey },
        action: "payment.unknown",
        payload: { runId: run.id, reason: result.reason },
      });
      await this.markReconcile(ctx, run, `Payment outcome unknown (${result.reason}); reconciling`);
    }
  }

  private async amountChanged(ctx: Ctx, run: Run, fresh: Bill, actor: Actor) {
    const proposal = requireProposal(run);
    const previous = await ctx.store.getApproval(run.approvalId ?? "");
    if (previous && previous.status !== "superseded") {
      await ctx.store.saveApproval({ ...previous, status: "superseded" });
    }
    const blocked = await this.capCheck(ctx.store, run, fresh.amountCents);
    if (blocked) {
      // `fail` is not allowed from awaiting_approval, and the run is still pre-charge.
      return run.state === "executing"
        ? this.fail(ctx, run, actor, blocked)
        : this.cancelRun(ctx, run, actor, blocked.message);
    }
    const approval = await this.newApproval(ctx, run, fresh.amountCents, fresh.currency, actor);
    return this.move(
      ctx,
      run,
      "amount_changed",
      actor,
      "Bill amount changed; needs a new approval",
      { proposal: { ...proposal, amountCents: fresh.amountCents }, approvalId: approval.id },
      { fromCents: proposal.amountCents, toCents: fresh.amountCents, approvalId: approval.id },
    );
  }

  private async newApproval(
    ctx: Ctx,
    run: Run,
    amountCents: number,
    currency: Approval["currency"],
    actor: Actor,
  ) {
    const approval: Approval = {
      id: this.ids(),
      runId: run.id,
      amountCents,
      currency,
      status: "pending",
      requestedAt: this.now(),
    };
    await ctx.store.saveApproval(approval);
    await this.audit(ctx, {
      actor,
      entity: { type: "approval", id: approval.id },
      action: "approval.requested",
      payload: { runId: run.id, amountCents, currency },
    });
    return approval;
  }

  private async currentApproval(store: Store, run: Run, approvalId: string): Promise<Approval> {
    const approval = await store.getApproval(approvalId);
    const proposal = requireProposal(run);
    if (
      !approval ||
      approval.runId !== run.id ||
      approval.id !== run.approvalId ||
      approval.status !== "pending" ||
      approval.amountCents !== proposal.amountCents
    ) {
      throw new HardwoodError(
        "stale_approval",
        "approval is not the run's current pending approval",
      );
    }
    return approval;
  }

  private async decide(
    ctx: Ctx,
    approval: Approval,
    status: "approved" | "rejected",
    d: ApprovalDecision,
    actor: Actor,
  ) {
    await ctx.store.saveApproval({
      ...approval,
      status,
      decidedAt: this.now(),
      decidedBy: d.decidedBy,
      comment: d.comment,
    });
    await this.audit(ctx, {
      actor,
      entity: { type: "approval", id: approval.id },
      action: `approval.${status}`,
      payload: { runId: approval.runId, amountCents: approval.amountCents, comment: d.comment },
    });
  }

  private async capCheck(store: Store, run: Run, amountCents: number) {
    const inst = await store.getInstallation(run.workspaceId, run.agentId);
    if (!inst) throw new HardwoodError("agent_disabled", `${run.agentId} is not installed`);
    const { from, to } = mexicoCityMonth(this.clock.now());
    const committed = await store.committedCents(run.workspaceId, run.agentId, from, to);
    const decision = evaluatePayment(inst.policy, amountCents, committed);
    if (decision.decision === "blocked") {
      return {
        code: "policy_blocked",
        message: `monthly cap of ${decision.capCents} cents would be exceeded (${decision.wouldSpendCents})`,
      };
    }
    return null;
  }

  private async cancelActive(
    ctx: Ctx,
    filter: { agentId: string; workspaceId?: string },
    actor: Actor,
    reason: string,
  ) {
    const runs = await ctx.store.listRuns({ ...filter, states: CANCELLABLE });
    for (const run of runs) await this.cancelRun(ctx, run, actor, reason);
  }

  private async cancelRun(ctx: Ctx, run: Run, actor: Actor, reason: string) {
    if (!canTransition(run.state, "cancel")) nextState(run.state, "cancel");
    if (run.approvalId) {
      const approval = await ctx.store.getApproval(run.approvalId);
      if (approval?.status === "pending") {
        await ctx.store.saveApproval({ ...approval, status: "superseded" });
      }
    }
    return this.move(ctx, run, "cancel", actor, `Cancelled: ${reason}`, undefined, { reason });
  }

  private fail(
    ctx: Ctx,
    run: Run,
    actor: Actor,
    error: { code: string; message: string },
    patch: Partial<Run> = {},
  ) {
    return this.move(
      ctx,
      run,
      "fail",
      actor,
      `Failed: ${error.message}`,
      { ...patch, error },
      error,
    );
  }

  private async assertNothingInFlight(store: Store, run: Run) {
    const key = run.proposal?.paymentKey;
    const record = key ? await store.getPayment(key) : null;
    if (record && record.runId === run.id && record.status !== "failed") {
      throw new HardwoodError(
        "invalid_transition",
        "a payment may be in flight; it fails only once the connector confirms no charge",
      );
    }
  }

  private async markReconcile(ctx: Ctx, run: Run, message: string) {
    return this.touch(ctx, run, { reconciliation: "pending" }, "payment.unknown", message);
  }

  /** Write a run without changing state (bumps the version so racing writers lose). */
  private async touch(ctx: Ctx, run: Run, patch: Partial<Run>, kind: string, message: string) {
    const next: Run = { ...run, ...patch, version: run.version + 1, updatedAt: this.now() };
    await ctx.store.updateRun(next);
    await this.step(ctx, next, kind, message);
    return next;
  }

  private async move(
    ctx: Ctx,
    run: Run,
    event: RunEvent,
    actor: Actor,
    message: string,
    patch: Partial<Run> = {},
    data: Record<string, unknown> = {},
  ): Promise<Run> {
    const to = nextState(run.state, event);
    const next: Run = {
      ...run,
      ...patch,
      state: to,
      version: run.version + 1,
      updatedAt: this.now(),
    };
    await ctx.store.updateRun(next);
    await this.step(ctx, next, event, message, data);
    await this.audit(ctx, {
      actor,
      entity: { type: "run", id: run.id },
      action: `run.${event}`,
      payload: { from: run.state, to, ...data },
    });
    ctx.emit(this.event(`run.${to}`, next, { from: run.state, ...data }));
    return next;
  }

  private async step(
    ctx: Ctx,
    run: Run,
    kind: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    if (data) assertNoSecrets(data);
    await ctx.store.addStep({ runId: run.id, at: this.now(), kind, message, data });
  }

  private async audit(ctx: Ctx, input: AuditInput) {
    const prev = await ctx.store.lastAuditEvent();
    await ctx.store.appendAuditEvent(createAuditEvent(prev, input, this.clock.now()));
  }

  /** Run `fn` in a store transaction; emit its events only after it commits. */
  private async tx<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    const pending: DomainEvent[] = [];
    const result = await this.store.transaction((store) =>
      fn({ store, emit: (e) => pending.push(e) }),
    );
    for (const e of pending) await this.events.emit(e);
    return result;
  }

  private async assertAgentAvailable(store: Store, workspaceId: string, agentId: string) {
    if (await store.isKillSwitchOn(agentId)) {
      throw new HardwoodError("agent_killed", `${agentId} is disabled for all workspaces`);
    }
    const inst = await store.getInstallation(workspaceId, agentId);
    if (!inst?.enabled) throw new HardwoodError("agent_disabled", `${agentId} is off here`);
    return inst;
  }

  private async load(store: Store, runId: string): Promise<Run> {
    const run = await store.getRun(runId);
    if (!run) throw new HardwoodError("not_found", `run ${runId} not found`);
    return run;
  }

  private async loadVersion(store: Store, runId: string, version: number): Promise<Run> {
    const run = await this.load(store, runId);
    if (run.version !== version) {
      throw new HardwoodError("concurrency_conflict", `run ${runId} changed during the operation`);
    }
    return run;
  }

  private async outcome(runId: string): Promise<ExecuteOutcome> {
    const run = await this.load(this.store, runId);
    if (run.state === "executing") return "reconciliation_pending";
    if (run.state === "succeeded" || run.state === "awaiting_approval") return run.state;
    return "failed";
  }

  private manifest(agentId: string): AgentManifest {
    const m = this.agents.get(agentId);
    if (!m) throw new HardwoodError("not_found", `unknown agent ${agentId}`);
    return m;
  }

  private effect(run: Run) {
    return findAction(this.manifest(run.agentId), run.action)?.effect;
  }

  private agentActor(run: Run): Actor {
    return { type: "agent", ref: run.agentId };
  }

  private event(type: WebhookEventType, run: Run, data: Record<string, unknown>): DomainEvent {
    return { type, workspaceId: run.workspaceId, runId: run.id, at: this.now(), data };
  }

  private now() {
    return this.clock.now().toISOString();
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HardwoodError("invalid_input", `invalid ${what}`, { issues: r.error.issues });
  }
  return r.data;
}

function requireProposal(run: Run) {
  if (!run.proposal) throw new HardwoodError("invalid_transition", "run has no payment proposal");
  return run.proposal;
}

const requesterActor = (r: RunRequester): Actor["type"] =>
  r === "schedule" ? "system" : r === "agent" ? "agent" : r === "host" ? "host" : "user";
