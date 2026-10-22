import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { verifyAuditChain } from "./audit.js";
import type { Bill } from "./connector.js";
import { AgentEngine } from "./engine.js";
import type { ErrorCode } from "./errors.js";
import { isHardwoodError } from "./errors.js";
import type { AgentManifest } from "./manifest.js";
import type { Actor } from "./run.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryStore,
  ScriptedConnector,
  sequentialIds,
} from "./testing/index.js";

const agent: AgentManifest = {
  id: "test-utilities",
  name: "Test Utilities",
  version: "0.1.0",
  description: "Fixture agent",
  capabilities: ["bills:read", "payments:request", "payments:execute"],
  actions: [
    {
      name: "lookup_bill",
      description: "Look up the current bill",
      input: z.object({ accountRef: z.string() }),
      capability: "bills:read",
      effect: "read",
    },
    {
      name: "pay_bill",
      description: "Pay the current bill",
      input: z.object({ accountRef: z.string() }),
      capability: "payments:request",
      effect: "payment",
    },
  ],
  settingsSchema: z.object({ notifyDaysBeforeDue: z.number().int().default(3) }),
};

const WS = "ws_1";
const ACCOUNT = "123456789012";
const owner: Actor = { type: "user", ref: "user_owner" };
const bill = (amountCents = 84_250, period = "2026-09"): Bill => ({
  billerId: "cfe",
  accountRef: ACCOUNT,
  period,
  amountCents,
  currency: "MXN",
  dueDate: "2026-10-30",
});

async function expectError(p: Promise<unknown>, code: ErrorCode) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(isHardwoodError(err, code), `expected ${code}, got ${String(err)}`).toBe(true);
}

let store: InMemoryStore;
let events: CollectingEventSink;
let clock: FakeClock;
let engine: AgentEngine;
let cfe: ScriptedConnector;
let keyN = 0;

beforeEach(async () => {
  store = new InMemoryStore();
  events = new CollectingEventSink();
  clock = new FakeClock();
  engine = new AgentEngine({ store, events, clock, ids: sequentialIds(), agents: [agent] });
  cfe = new ScriptedConnector("cfe", bill());
  await engine.installAgent(
    WS,
    agent.id,
    { settings: {}, policy: { approverRoles: ["owner"], monthlyCapCents: 1_000_000 } },
    owner,
  );
});

const request = (action = "pay_bill", key = `idem_key_${++keyN}`, ws = WS) =>
  engine.requestRun({
    workspaceId: ws,
    agentId: agent.id,
    action,
    input: { accountRef: ACCOUNT },
    idempotencyKey: key,
    requestedBy: "user",
    requestedByRef: "user_owner",
  });

const decision = (approvalId: string | undefined, roles = ["owner"]) => ({
  approvalId: approvalId ?? "",
  decidedBy: "user_owner",
  roles,
});

/** Request → start → propose: a run waiting for approval. */
async function awaitingRun(b = bill(), key?: string) {
  const { run } = await request("pay_bill", key);
  await engine.startRun(run.id);
  return engine.proposePayment(run.id, b);
}

async function approvedRun(b = bill()) {
  const run = await awaitingRun(b);
  return engine.approve(run.id, decision(run.approvalId));
}

describe("read actions", () => {
  it("complete without approval", async () => {
    const { run } = await request("lookup_bill");
    expect(run.state).toBe("queued");
    await engine.startRun(run.id);
    const done = await engine.completeRun(run.id, { bill: bill() });
    expect(done.state).toBe("succeeded");
    expect(done.output).toEqual({ bill: bill() });
    expect(events.types()).toEqual(["run.queued", "run.running", "run.succeeded"]);
  });

  it("cannot be proposed as payments, and payments cannot be completed", async () => {
    const { run } = await request("lookup_bill");
    await engine.startRun(run.id);
    await expectError(engine.proposePayment(run.id, bill()), "invalid_transition");
    const pay = await awaitingRun();
    await expectError(engine.completeRun(pay.id, {}), "invalid_transition");
  });
});

describe("pay flow", () => {
  it("runs request → approval → payment → receipt", async () => {
    const run = await awaitingRun();
    expect(run.state).toBe("awaiting_approval");
    expect(run.proposal?.paymentKey).toBe(`pay:${WS}:cfe:${ACCOUNT}:2026-09`);
    expect(cfe.payCalls).toBe(0);

    const approved = await engine.approve(run.id, { ...decision(run.approvalId), comment: "ok" });
    expect(approved.state).toBe("executing");
    expect(cfe.payCalls).toBe(0);

    expect(await engine.execute(run.id, cfe)).toBe("succeeded");
    const { run: done, steps, approval } = await engine.getRun(run.id);
    expect(done.state).toBe("succeeded");
    expect(done.output).toMatchObject({ folio: "SIM-1", amountCents: 84_250 });
    expect(approval?.status).toBe("approved");
    expect(approval?.comment).toBe("ok");
    expect(cfe.payCalls).toBe(1);
    expect(steps.map((s) => s.kind)).toEqual([
      "queued",
      "start",
      "propose",
      "approve",
      "payment.started",
      "succeed",
    ]);
    expect(events.types()).toEqual([
      "run.queued",
      "run.running",
      "bill.found",
      "run.awaiting_approval",
      "run.executing",
      "run.succeeded",
    ]);
  });

  it("writes a valid audit chain covering every state change", async () => {
    const run = await approvedRun();
    await engine.execute(run.id, cfe);
    const log = store.auditLog();
    expect(verifyAuditChain(log)).toMatchObject({ ok: true });
    expect(log.map((e) => e.action)).toEqual([
      "installation.saved",
      "run.requested",
      "run.start",
      "approval.requested",
      "run.propose",
      "approval.approved",
      "run.approve",
      "payment.claimed",
      "payment.paid",
      "run.succeed",
    ]);
    expect(log.find((e) => e.action === "approval.approved")?.actor).toEqual(owner);
  });

  it("never pays before approval", async () => {
    const run = await awaitingRun();
    await expectError(engine.execute(run.id, cfe), "invalid_transition");
    expect(cfe.payCalls).toBe(0);
  });
});

describe("idempotency", () => {
  it("same key twice → one run and one execution", async () => {
    const first = await request("pay_bill", "same_key_123");
    const second = await request("pay_bill", "same_key_123");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);

    await engine.startRun(first.run.id);
    const run = await engine.proposePayment(first.run.id, bill());
    await engine.approve(run.id, decision(run.approvalId));
    await engine.execute(run.id, cfe);
    await expectError(engine.execute(run.id, cfe), "invalid_transition");
    expect(cfe.payCalls).toBe(1);
    expect(events.types().filter((t) => t === "run.queued")).toHaveLength(1);
  });

  it("rejects a reused key with a different request", async () => {
    await request("pay_bill", "same_key_123");
    await expectError(request("lookup_bill", "same_key_123"), "idempotency_conflict");
  });

  it("scopes keys per workspace", async () => {
    await engine.installAgent(
      "ws_2",
      agent.id,
      { settings: {}, policy: { approverRoles: ["owner"] } },
      owner,
    );
    const a = await request("pay_bill", "shared_key_1", WS);
    const b = await request("pay_bill", "shared_key_1", "ws_2");
    expect(b.created).toBe(true);
    expect(b.run.id).not.toBe(a.run.id);
  });

  it("concurrent executes charge once", async () => {
    const run = await approvedRun();
    const results = await Promise.allSettled([
      engine.execute(run.id, cfe),
      engine.execute(run.id, cfe),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(cfe.payCalls).toBe(1);
    expect((await engine.getRun(run.id)).run.state).toBe("succeeded");
  });

  it("a second run for an already-paid bill fails without paying", async () => {
    const first = await approvedRun();
    await engine.execute(first.id, cfe);
    const second = await awaitingRun();
    expect(second.state).toBe("failed");
    expect(second.error?.code).toBe("already_paid");
    expect(cfe.payCalls).toBe(1);
  });

  it("two approved runs for the same bill pay once", async () => {
    const a = await awaitingRun();
    const b = await awaitingRun();
    await engine.approve(a.id, decision(a.approvalId));
    await engine.approve(b.id, decision(b.approvalId));
    expect(await engine.execute(a.id, cfe)).toBe("succeeded");
    expect(await engine.execute(b.id, cfe)).toBe("failed");
    expect((await engine.getRun(b.id)).run.error?.code).toBe("already_paid");
    expect(cfe.payCalls).toBe(1);
  });

  it("validates keys and input", async () => {
    await expectError(request("pay_bill", "short"), "invalid_input");
    await expectError(
      engine.requestRun({
        workspaceId: WS,
        agentId: agent.id,
        action: "pay_bill",
        input: { accountRef: 42 },
        idempotencyKey: "valid_key_1",
        requestedBy: "agent",
      }),
      "invalid_input",
    );
    await expectError(request("delete_everything"), "not_found");
    await expectError(
      engine.requestRun({
        workspaceId: WS,
        agentId: "nope",
        action: "pay_bill",
        input: {},
        idempotencyKey: "valid_key_1",
        requestedBy: "agent",
      }),
      "not_found",
    );
  });
});

describe("off means off", () => {
  it("disabling an add-in cancels queued, running and waiting runs", async () => {
    const queued = (await request()).run;
    const running = (await request()).run;
    await engine.startRun(running.id);
    const waiting = await awaitingRun();

    await engine.setEnabled(WS, agent.id, false, owner);

    for (const id of [queued.id, running.id, waiting.id]) {
      expect((await engine.getRun(id)).run.state).toBe("cancelled");
    }
    expect((await engine.getRun(waiting.id)).approval?.status).toBe("superseded");
    await expectError(request(), "agent_disabled");
    await expectError(
      engine.approve(waiting.id, decision(waiting.approvalId)),
      "invalid_transition",
    );
  });

  it("leaves an executing run to finish", async () => {
    const run = await approvedRun();
    await engine.setEnabled(WS, agent.id, false, owner);
    expect((await engine.getRun(run.id)).run.state).toBe("executing");
    expect(await engine.execute(run.id, cfe)).toBe("succeeded");
  });

  it("re-enabling allows new runs", async () => {
    await engine.setEnabled(WS, agent.id, false, owner);
    await engine.setEnabled(WS, agent.id, true, owner);
    expect((await request()).created).toBe(true);
  });

  it("installing disabled cancels too, and unknown installs are not found", async () => {
    const run = (await request()).run;
    await engine.installAgent(
      WS,
      agent.id,
      { settings: {}, policy: { approverRoles: ["owner"] }, enabled: false },
      owner,
    );
    expect((await engine.getRun(run.id)).run.state).toBe("cancelled");
    await expectError(engine.setEnabled("ws_x", agent.id, true, owner), "not_found");
  });

  it("the kill switch stops the agent in every workspace", async () => {
    await engine.installAgent(
      "ws_2",
      agent.id,
      { settings: {}, policy: { approverRoles: ["owner"] } },
      owner,
    );
    const a = (await request("pay_bill", "kill_key_1", WS)).run;
    const b = (await request("pay_bill", "kill_key_2", "ws_2")).run;

    await engine.setKillSwitch(agent.id, true, { type: "system" });

    expect((await engine.getRun(a.id)).run.state).toBe("cancelled");
    expect((await engine.getRun(b.id)).run.state).toBe("cancelled");
    await expectError(request("pay_bill", "kill_key_3"), "agent_killed");

    await engine.setKillSwitch(agent.id, false, { type: "system" });
    expect((await request("pay_bill", "kill_key_4")).created).toBe(true);
    await expectError(engine.setKillSwitch("nope", true, { type: "system" }), "not_found");
  });

  it("a run cannot start or be approved once the agent is off", async () => {
    const queued = (await request()).run;
    const waiting = await awaitingRun();
    await store.setKillSwitch(agent.id, true); // flipped without the engine's cancel sweep
    await expectError(engine.startRun(queued.id), "agent_killed");
    await expectError(engine.approve(waiting.id, decision(waiting.approvalId)), "agent_killed");
  });
});

describe("amount changes", () => {
  it("a different amount at execution goes back for a new approval", async () => {
    const run = await approvedRun();
    const firstApproval = run.approvalId;
    cfe.bill = bill(91_000);

    expect(await engine.execute(run.id, cfe)).toBe("awaiting_approval");
    const { run: back, approval } = await engine.getRun(run.id);
    expect(back.proposal?.amountCents).toBe(91_000);
    expect(back.approvalId).not.toBe(firstApproval);
    expect(approval).toMatchObject({ status: "pending", amountCents: 91_000 });
    expect(cfe.payCalls).toBe(0);

    await expectError(engine.approve(run.id, decision(firstApproval)), "stale_approval");
    await engine.approve(run.id, decision(back.approvalId));
    expect(await engine.execute(run.id, cfe)).toBe("succeeded");
    expect((await engine.getRun(run.id)).run.output).toMatchObject({ amountCents: 91_000 });
  });

  it("a refresh while waiting replaces the pending approval", async () => {
    const run = await awaitingRun();
    cfe.bill = bill(70_000);
    const refreshed = await engine.refreshProposal(run.id, cfe);
    expect(refreshed.state).toBe("awaiting_approval");
    expect(refreshed.approvalId).not.toBe(run.approvalId);
    await expectError(engine.approve(run.id, decision(run.approvalId)), "stale_approval");

    cfe.bill = bill(70_000);
    const unchanged = await engine.refreshProposal(run.id, cfe);
    expect(unchanged.approvalId).toBe(refreshed.approvalId);
  });

  it("a new amount over the cap fails instead of asking again", async () => {
    const run = await approvedRun();
    cfe.bill = bill(2_000_000);
    expect(await engine.execute(run.id, cfe)).toBe("failed");
    expect((await engine.getRun(run.id)).run.error?.code).toBe("policy_blocked");
  });

  it("a refresh to an amount over the cap cancels the waiting run", async () => {
    const run = await awaitingRun();
    cfe.bill = bill(2_000_000);
    expect((await engine.refreshProposal(run.id, cfe)).state).toBe("cancelled");
  });

  it("a bill that disappeared fails before any charge", async () => {
    const run = await approvedRun();
    cfe.bill = bill(84_250, "2026-10");
    expect(await engine.execute(run.id, cfe)).toBe("failed");
    expect((await engine.getRun(run.id)).run.error?.code).toBe("bill_not_found");
    expect(cfe.payCalls).toBe(0);
  });
});

describe("approvals", () => {
  it("rejects end the run without paying", async () => {
    const run = await awaitingRun();
    const done = await engine.reject(run.id, decision(run.approvalId));
    expect(done.state).toBe("rejected");
    expect((await engine.getRun(run.id)).approval?.status).toBe("rejected");
    expect(cfe.payCalls).toBe(0);
  });

  it("requires an approver role", async () => {
    const run = await awaitingRun();
    await expectError(engine.approve(run.id, decision(run.approvalId, ["viewer"])), "forbidden");
    await expectError(engine.reject(run.id, decision(run.approvalId, ["viewer"])), "forbidden");
    // Nothing was written by the failed attempts.
    expect(
      store
        .auditLog()
        .filter((e) => e.action.startsWith("approval.") && e.action !== "approval.requested"),
    ).toEqual([]);
  });

  it("needs the run's current approval id", async () => {
    const run = await awaitingRun();
    await expectError(engine.approve(run.id, decision("someone_elses")), "stale_approval");
    await expectError(engine.reject(run.id, decision(undefined)), "stale_approval");
  });

  it("re-checks the monthly cap at approval time", async () => {
    const a = await awaitingRun(bill(600_000, "2026-08"));
    const b = await awaitingRun(bill(600_000, "2026-09"));
    await engine.approve(a.id, decision(a.approvalId));
    await engine.execute(a.id, new ScriptedConnector("cfe", bill(600_000, "2026-08")));
    await expectError(engine.approve(b.id, decision(b.approvalId)), "policy_blocked");
    expect((await engine.getRun(b.id)).run.state).toBe("awaiting_approval");
  });
});

describe("policy", () => {
  it("blocks a proposal over the monthly cap", async () => {
    const run = await awaitingRun(bill(1_000_001));
    expect(run.state).toBe("failed");
    expect(run.error?.code).toBe("policy_blocked");
  });

  it("counts in-flight payments toward the cap", async () => {
    const first = await approvedRun(bill(700_000, "2026-08"));
    const slow = new ScriptedConnector("cfe", bill(700_000, "2026-08"));
    slow.payScript = ["unknown"];
    await engine.execute(first.id, slow);
    const second = await awaitingRun(bill(400_000, "2026-09"));
    expect(second.error?.code).toBe("policy_blocked");
  });

  it("resets the cap each Mexico City month", async () => {
    const first = await approvedRun(bill(900_000, "2026-08"));
    await engine.execute(first.id, new ScriptedConnector("cfe", bill(900_000, "2026-08")));
    clock.set("2026-11-01T07:00:00Z");
    expect((await awaitingRun(bill(900_000, "2026-09"))).state).toBe("awaiting_approval");
  });

  it("validates settings and policy on install", async () => {
    await expectError(
      engine.installAgent(
        WS,
        agent.id,
        { settings: { notifyDaysBeforeDue: "x" }, policy: { approverRoles: ["owner"] } },
        owner,
      ),
      "invalid_input",
    );
    await expectError(
      engine.installAgent(WS, agent.id, { settings: {}, policy: { approverRoles: [] } }, owner),
      "invalid_input",
    );
    // Unknown settings keys are stripped, so a secret never reaches storage.
    const inst = await engine.installAgent(
      WS,
      agent.id,
      { settings: { password: "x" }, policy: { approverRoles: ["owner"] } },
      owner,
    );
    expect(inst.settings).toEqual({ notifyDaysBeforeDue: 3 });
  });
});

describe("failures and reconciliation", () => {
  it("a declined payment fails and frees the bill for a new attempt", async () => {
    const run = await approvedRun();
    cfe.payScript = ["declined"];
    expect(await engine.execute(run.id, cfe)).toBe("failed");
    expect((await engine.getRun(run.id)).run.error?.code).toBe("payment_declined");

    const retry = await approvedRun();
    expect(await engine.execute(retry.id, cfe)).toBe("succeeded");
    expect(cfe.charged.size).toBe(1);
  });

  it("a timeout waits for reconciliation and never pays twice", async () => {
    const run = await approvedRun();
    cfe.payScript = ["unknown"];
    expect(await engine.execute(run.id, cfe)).toBe("reconciliation_pending");
    const { run: pending, steps } = await engine.getRun(run.id);
    expect(pending.state).toBe("executing");
    expect(pending.reconciliation).toBe("pending");
    expect(steps.at(-1)?.kind).toBe("payment.unknown");

    await expectError(engine.execute(run.id, cfe), "invalid_transition");
    await expectError(
      engine.failRun(run.id, { code: "timeout", message: "gave up" }),
      "invalid_transition",
    );
    await expectError(engine.cancel(run.id, owner), "invalid_transition");

    expect(await engine.reconcile(run.id, cfe)).toBe("succeeded");
    expect((await engine.getRun(run.id)).run.reconciliation).toBeUndefined();
    expect(cfe.payCalls).toBe(1);
    expect(cfe.charged.get(run.proposal?.paymentKey ?? "")).toBe(1);
  });

  it("marks failed only once the connector confirms no charge", async () => {
    const run = await approvedRun();
    cfe.payScript = ["throw"];
    expect(await engine.execute(run.id, cfe)).toBe("reconciliation_pending");

    cfe.checkScript = ["unknown"];
    expect(await engine.reconcile(run.id, cfe)).toBe("reconciliation_pending");
    expect(await engine.reconcile(run.id, cfe)).toBe("failed");
    expect((await engine.getRun(run.id)).run.error?.code).toBe("payment_declined");
  });

  it("treats a failing reconciliation check as still unknown", async () => {
    const run = await approvedRun();
    cfe.payScript = ["unknown"];
    await engine.execute(run.id, cfe);
    const broken = new ScriptedConnector("cfe", bill());
    broken.checkPayment = () => Promise.reject(new Error("down"));
    expect(await engine.reconcile(run.id, broken)).toBe("reconciliation_pending");
  });

  it("only reconciles runs that need it", async () => {
    const run = await approvedRun();
    await expectError(engine.reconcile(run.id, cfe), "invalid_transition");
  });

  it("flags a charge that differs from the approved amount", async () => {
    const run = await approvedRun();
    const odd = new ScriptedConnector("cfe", bill());
    odd.pay = async () => ({
      status: "paid",
      folio: "SIM-X",
      amountCents: 1,
      paidAt: "2026-10-15T18:00:00.000Z",
    });
    expect(await engine.execute(run.id, odd)).toBe("succeeded");
    const { steps } = await engine.getRun(run.id);
    expect(steps.at(-1)?.data).toMatchObject({ amountMismatch: true, approvedCents: 84_250 });
  });

  it("refuses connectors that cannot pay or do not match", async () => {
    const run = await approvedRun();
    const assisted = new ScriptedConnector("cfe", bill());
    Object.assign(assisted, { pay: undefined, mode: "assisted" });
    await expectError(engine.execute(run.id, assisted), "unsupported");
    await expectError(
      engine.execute(run.id, new ScriptedConnector("sacmex", bill())),
      "invalid_input",
    );
  });

  it("fails a running run on error", async () => {
    const { run } = await request();
    await engine.startRun(run.id);
    const failed = await engine.failRun(run.id, { code: "lookup_failed", message: "no bill" });
    expect(failed.state).toBe("failed");
    expect(events.types().at(-1)).toBe("run.failed");
  });

  it("rejects secrets in run input", async () => {
    const withSecret: AgentManifest = {
      ...agent,
      id: "leaky",
      actions: [
        {
          name: "pay_bill",
          description: "x",
          input: z.object({ accountRef: z.string(), password: z.string() }),
          capability: "payments:request",
          effect: "payment",
        },
      ],
    };
    const e = new AgentEngine({ store, events, clock, agents: [withSecret] });
    await e.installAgent(
      WS,
      "leaky",
      { settings: {}, policy: { approverRoles: ["owner"] } },
      owner,
    );
    await expectError(
      e.requestRun({
        workspaceId: WS,
        agentId: "leaky",
        action: "pay_bill",
        input: { accountRef: ACCOUNT, password: "hunter2" },
        idempotencyKey: "leaky_key_1",
        requestedBy: "user",
      }),
      "secret_detected",
    );
  });

  it("rejects duplicate agent registrations and unknown runs", async () => {
    expect(() => new AgentEngine({ store, events, agents: [agent, agent] })).toThrow(
      /duplicate agent/,
    );
    await expectError(engine.getRun("missing"), "not_found");
    expect(engine.catalog().map((m) => m.id)).toEqual([agent.id]);
  });

  it("recovers from a crash after the claim without paying again", async () => {
    const run = await approvedRun();
    // Simulate a worker that committed the claim and died before calling the connector.
    await store.claimPayment({
      paymentKey: run.proposal?.paymentKey ?? "",
      runId: run.id,
      workspaceId: WS,
      agentId: agent.id,
      amountCents: 84_250,
      currency: "MXN",
      status: "pending",
      claimedAt: clock.now().toISOString(),
    });
    expect(await engine.execute(run.id, cfe)).toBe("reconciliation_pending");
    expect(cfe.payCalls).toBe(0);
    expect(await engine.reconcile(run.id, cfe)).toBe("failed");
    expect((await engine.getRun(run.id)).run.error?.code).toBe("payment_declined");
  });

  it("does not propose a bill another run is still paying", async () => {
    const first = await approvedRun();
    cfe.payScript = ["unknown"];
    await engine.execute(first.id, cfe);
    const second = await awaitingRun();
    expect(second.state).toBe("failed");
    expect(second.error?.code).toBe("payment_in_progress");
  });

  it("refuses wrong-state proposals, rejections and reconciliations", async () => {
    const { run } = await request();
    await expectError(engine.proposePayment(run.id, bill()), "invalid_transition");
    await expectError(engine.reject(run.id, decision("x")), "invalid_transition");
    await expectError(engine.proposePayment(run.id, bill(0)), "invalid_input");
    expect((await engine.refreshProposal(run.id, cfe)).state).toBe("queued");

    const pending = await approvedRun();
    cfe.payScript = ["unknown"];
    await engine.execute(pending.id, cfe);
    const noCheck = new ScriptedConnector("cfe", bill());
    Object.assign(noCheck, { checkPayment: undefined });
    await expectError(engine.reconcile(pending.id, noCheck), "unsupported");
  });

  it("cancels a queued run on request", async () => {
    const { run } = await request();
    expect((await engine.cancel(run.id, owner, "changed my mind")).state).toBe("cancelled");
    await expectError(engine.cancel(run.id, owner), "invalid_transition");
  });
});
