import type { Bill } from "@hardwood/agents-core";
import { AgentEngine, isHardwoodError } from "@hardwood/agents-core";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryStore,
  ScriptedConnector,
} from "@hardwood/agents-core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { utilitiesAgent } from "./manifest.js";
import { UtilitiesRunner, connectorRegistry } from "./runner.js";

const REF = "123456789012";
const bill = (over: Partial<Bill> = {}): Bill => ({
  billerId: "cfe",
  accountRef: REF,
  period: "2026-B5",
  amountCents: 84_250,
  currency: "MXN",
  dueDate: "2026-10-30",
  ...over,
});

let engine: AgentEngine;
let cfe: ScriptedConnector;
let runner: UtilitiesRunner;
let n = 0;

beforeEach(async () => {
  engine = new AgentEngine({
    store: new InMemoryStore(),
    events: new CollectingEventSink(),
    clock: new FakeClock(),
    agents: [utilitiesAgent],
  });
  cfe = new ScriptedConnector("cfe", bill());
  runner = new UtilitiesRunner(engine, connectorRegistry([cfe]));
  await engine.installAgent(
    "ws_1",
    "utilities",
    { settings: {}, policy: { approverRoles: ["owner"] } },
    { type: "user", ref: "u1" },
  );
});

const request = async (
  action: string,
  input: Record<string, unknown> = { billerId: "cfe", accountRef: REF },
) =>
  (
    await engine.requestRun({
      workspaceId: "ws_1",
      agentId: "utilities",
      action,
      input,
      idempotencyKey: `runner_key_${++n}`,
      requestedBy: "user",
    })
  ).run.id;

describe("UtilitiesRunner", () => {
  it("completes a lookup with the bill", async () => {
    const run = await runner.process(await request("lookup_bill"));
    expect(run.state).toBe("succeeded");
    expect(run.output).toEqual({ bill: bill() });
  });

  it("stops a payment at approval", async () => {
    const run = await runner.process(await request("pay_bill"));
    expect(run.state).toBe("awaiting_approval");
    expect(cfe.payCalls).toBe(0);
  });

  it.each([
    ["no_open_bill", () => (cfe.bill = null)],
    ["connector_mismatch", () => (cfe.bill = { ...bill(), billerId: "sacmex" })],
    [
      "lookup_failed",
      () => {
        cfe.lookup = () => Promise.reject(new Error("portal said: user=x"));
      },
    ],
    ["invalid_account_ref", () => (cfe.validateAccountRef = () => false)],
  ])("fails with %s", async (code, arrange) => {
    arrange();
    const run = await runner.process(await request("pay_bill"));
    expect(run.state).toBe("failed");
    expect(run.error?.code).toBe(code);
    expect(JSON.stringify(run)).not.toContain("portal said");
  });

  it("fails when the open bill is for another period", async () => {
    const run = await runner.process(
      await request("pay_bill", { billerId: "cfe", accountRef: REF, period: "2026-B4" }),
    );
    expect(run.error?.code).toBe("period_mismatch");
  });

  it("needs a connector for the biller", async () => {
    const id = await request("pay_bill", { billerId: "sacmex", accountRef: "1234567890123456" });
    await expect(runner.process(id)).rejects.toSatisfy((e) => isHardwoodError(e, "unsupported"));
    await expect(runner.execute(id)).rejects.toSatisfy((e) =>
      isHardwoodError(e, "invalid_transition"),
    );
  });

  it("refuses runs from other agents", async () => {
    const other = new AgentEngine({
      store: new InMemoryStore(),
      events: new CollectingEventSink(),
      agents: [{ ...utilitiesAgent, id: "other" }],
    });
    await other.installAgent(
      "ws_1",
      "other",
      { settings: {}, policy: { approverRoles: ["owner"] } },
      { type: "system" },
    );
    const { run } = await other.requestRun({
      workspaceId: "ws_1",
      agentId: "other",
      action: "pay_bill",
      input: { billerId: "cfe", accountRef: REF },
      idempotencyKey: "other_key_1",
      requestedBy: "user",
    });
    await expect(
      new UtilitiesRunner(other, connectorRegistry([cfe])).process(run.id),
    ).rejects.toSatisfy((e) => isHardwoodError(e, "invalid_input"));
  });

  it("executes, refreshes and reconciles through the engine", async () => {
    const run = await runner.process(await request("pay_bill"));
    cfe.bill = bill({ amountCents: 90_000 });
    const refreshed = await runner.refresh(run.id);
    expect(refreshed.proposal?.amountCents).toBe(90_000);
    await engine.approve(run.id, {
      approvalId: refreshed.approvalId ?? "",
      decidedBy: "u1",
      roles: ["owner"],
    });
    cfe.payScript = ["unknown"];
    expect(await runner.execute(run.id)).toBe("reconciliation_pending");
    expect(await runner.reconcile(run.id)).toBe("succeeded");
    expect(cfe.payCalls).toBe(1);
  });
});
