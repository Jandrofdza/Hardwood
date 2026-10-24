// Phase 2 "done when": the full pay flow passes against the mock connector, with no DB.
import type { BillerId } from "@hardwood/agent-utilities";
import {
  BILLER_IDS,
  UtilitiesRunner,
  connectorRegistry,
  isValidAccountRef,
  normalizeAccountRef,
  utilitiesAgent,
} from "@hardwood/agent-utilities";
import { AgentEngine, isHardwoodError, verifyAuditChain } from "@hardwood/agents-core";
import { CollectingEventSink, FakeClock, InMemoryStore } from "@hardwood/agents-core/testing";
import { MockBillerConnector } from "@hardwood/connectors";
import { beforeEach, describe, expect, it } from "vitest";

const WS = "ws_demo";
const OWNER = { type: "user" as const, ref: "user_owner" };

/** Account references by biller, ending in the mock's scenario digit. */
const ref = (biller: BillerId, lastDigit: number) => {
  const body = { cfe: "10000000001", sacmex: "100000000000002", "predial-cdmx": "035-123-45-000-" }[
    biller
  ];
  return `${body}${lastDigit}`;
};

let store: InMemoryStore;
let events: CollectingEventSink;
let engine: AgentEngine;
let runner: UtilitiesRunner;
let mocks: Record<BillerId, MockBillerConnector>;
let keyN = 0;

beforeEach(async () => {
  store = new InMemoryStore();
  events = new CollectingEventSink();
  const clock = new FakeClock("2026-10-15T18:00:00Z");
  engine = new AgentEngine({ store, events, clock, agents: [utilitiesAgent] });
  mocks = Object.fromEntries(
    BILLER_IDS.map((id) => [
      id,
      new MockBillerConnector({
        billerId: id,
        validateAccountRef: (r) => isValidAccountRef(id, r),
        now: () => clock.now(),
      }),
    ]),
  ) as Record<BillerId, MockBillerConnector>;
  runner = new UtilitiesRunner(engine, connectorRegistry(Object.values(mocks)));
  await engine.installAgent(
    WS,
    utilitiesAgent.id,
    {
      settings: { notifyDaysBeforeDue: 5 },
      policy: { approverRoles: ["owner"], monthlyCapCents: 5_000_000 },
    },
    OWNER,
  );
});

async function request(
  action: string,
  billerId: BillerId,
  accountRef: string,
  key = `flow_key_${++keyN}`,
) {
  const { run } = await engine.requestRun({
    workspaceId: WS,
    agentId: utilitiesAgent.id,
    action,
    input: { billerId, accountRef },
    idempotencyKey: key,
    requestedBy: "user",
    requestedByRef: OWNER.ref,
  });
  return run.id;
}

async function approve(runId: string) {
  const { run } = await engine.getRun(runId);
  return engine.approve(runId, {
    approvalId: run.approvalId ?? "",
    decidedBy: OWNER.ref,
    roles: ["owner"],
  });
}

/** Request → look up → approve → execute. */
async function payThrough(billerId: BillerId, accountRef: string) {
  const id = await request("pay_bill", billerId, accountRef);
  const waiting = await runner.process(id);
  expect(waiting.state).toBe("awaiting_approval");
  await approve(id);
  return { id, outcome: await runner.execute(id) };
}

describe.each(BILLER_IDS)("%s", (billerId) => {
  const mock = () => mocks[billerId];

  it("pays an approved bill and keeps the receipt", async () => {
    const { id, outcome } = await payThrough(billerId, ref(billerId, 0));
    expect(outcome).toBe("succeeded");

    const { run, steps, approval } = await engine.getRun(id);
    const folio = `SIM-${billerId.toUpperCase()}-000001`;
    expect(run.output).toMatchObject({ folio, amountCents: run.proposal?.amountCents });
    expect(approval).toMatchObject({ status: "approved", decidedBy: OWNER.ref });
    expect(mock().charges).toEqual([
      expect.objectContaining({
        folio,
        amountCents: run.proposal?.amountCents,
        accountRef: normalizeAccountRef(ref(billerId, 0)),
      }),
    ]);
    expect(await mock().checkPayment(run.proposal?.paymentKey ?? "")).toMatchObject({
      status: "charged",
      receiptUrl: `sim://receipts/${folio}`,
    });
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
    expect(verifyAuditChain(store.auditLog())).toMatchObject({ ok: true });
  });

  it("fails a declined payment without charging", async () => {
    const { id, outcome } = await payThrough(billerId, ref(billerId, 5));
    expect(outcome).toBe("failed");
    expect((await engine.getRun(id)).run.error?.code).toBe("payment_declined");
    expect(mock().charges).toHaveLength(0);
  });

  it("reconciles a timeout that charged into a success, charging once", async () => {
    const { id, outcome } = await payThrough(billerId, ref(billerId, 6));
    expect(outcome).toBe("reconciliation_pending");
    expect(await runner.reconcile(id)).toBe("succeeded");
    expect(mock().charges).toHaveLength(1);
    expect((await engine.getRun(id)).run.output).toMatchObject({ folio: mock().charges[0]?.folio });
  });

  it("fails a timeout only once the mock confirms no charge", async () => {
    const { id, outcome } = await payThrough(billerId, ref(billerId, 7));
    expect(outcome).toBe("reconciliation_pending");
    expect((await engine.getRun(id)).run.state).toBe("executing");
    expect(await runner.reconcile(id)).toBe("failed");
    expect(mock().charges).toHaveLength(0);
  });

  it("asks again when the amount changes before paying", async () => {
    const { id, outcome } = await payThrough(billerId, ref(billerId, 8));
    expect(outcome).toBe("awaiting_approval");
    const { run: back, approval } = await engine.getRun(id);
    expect(approval?.status).toBe("pending");
    expect(mock().charges).toHaveLength(0);

    await approve(id);
    expect(await runner.execute(id)).toBe("succeeded");
    expect(mock().charges).toEqual([
      expect.objectContaining({ amountCents: back.proposal?.amountCents }),
    ]);
  });

  it("fails when nothing is owed", async () => {
    const run = await runner.process(await request("pay_bill", billerId, ref(billerId, 9)));
    expect(run.state).toBe("failed");
    expect(run.error?.code).toBe("no_open_bill");
  });

  it("looks a bill up without approval or payment", async () => {
    const run = await runner.process(await request("lookup_bill", billerId, ref(billerId, 1)));
    expect(run.state).toBe("succeeded");
    expect(run.output).toMatchObject({ bill: { billerId, currency: "MXN", period: "2026-B5" } });
    expect(mock().charges).toHaveLength(0);
  });
});

describe("one payment per bill", () => {
  it("the same idempotency key twice gives one run and one charge", async () => {
    const a = await request("pay_bill", "cfe", ref("cfe", 2), "owner_click_42");
    const b = await request("pay_bill", "cfe", ref("cfe", 2), "owner_click_42");
    expect(b).toBe(a);
    await runner.process(a);
    await approve(a);
    expect(await runner.execute(a)).toBe("succeeded");
    await expect(runner.execute(a)).rejects.toSatisfy((e) =>
      isHardwoodError(e, "invalid_transition"),
    );
    expect(mocks.cfe.charges).toHaveLength(1);
  });

  it("a second request for a paid bill fails as already paid", async () => {
    await payThrough("sacmex", ref("sacmex", 3));
    const again = await runner.process(await request("pay_bill", "sacmex", ref("sacmex", 3)));
    expect(again.error?.code).toBe("already_paid");
    expect(mocks.sacmex.charges).toHaveLength(1);
  });

  it("formatting differences in the account reference are the same bill", async () => {
    await payThrough("predial-cdmx", "035-123-45-000-4");
    const again = await runner.process(await request("pay_bill", "predial-cdmx", "035123450004"));
    expect(again.error?.code).toBe("already_paid");
  });
});

describe("guardrails", () => {
  it("a run requested by the model still waits for a human", async () => {
    const { run } = await engine.requestRun({
      workspaceId: WS,
      agentId: utilitiesAgent.id,
      action: "pay_bill",
      input: { billerId: "cfe", accountRef: ref("cfe", 0) },
      idempotencyKey: "assistant_req_1",
      requestedBy: "agent",
    });
    expect((await runner.process(run.id)).state).toBe("awaiting_approval");
    await expect(runner.execute(run.id)).rejects.toSatisfy((e) =>
      isHardwoodError(e, "invalid_transition"),
    );
    expect(mocks.cfe.charges).toHaveLength(0);
  });

  it("turning the add-in off cancels a bill waiting for approval", async () => {
    const id = await request("pay_bill", "cfe", ref("cfe", 0));
    await runner.process(id);
    await engine.setEnabled(WS, utilitiesAgent.id, false, OWNER);
    expect((await engine.getRun(id)).run.state).toBe("cancelled");
    await expect(approve(id)).rejects.toSatisfy((e) => isHardwoodError(e, "invalid_transition"));
    await expect(request("pay_bill", "cfe", ref("cfe", 1))).rejects.toSatisfy((e) =>
      isHardwoodError(e, "agent_disabled"),
    );
  });

  it("the monthly cap blocks a bill that would exceed it", async () => {
    await engine.installAgent(
      WS,
      utilitiesAgent.id,
      { settings: {}, policy: { approverRoles: ["owner"], monthlyCapCents: 10_000 } },
      OWNER,
    );
    const run = await runner.process(await request("pay_bill", "cfe", ref("cfe", 0)));
    expect(run.error?.code).toBe("policy_blocked");
  });

  it("rejects account references in the wrong format before any lookup", async () => {
    await expect(request("pay_bill", "sacmex", "12345")).rejects.toSatisfy((e) =>
      isHardwoodError(e, "invalid_input"),
    );
  });
});
