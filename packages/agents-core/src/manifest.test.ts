import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isHardwoodError } from "./errors.js";
import type { AgentManifest } from "./manifest.js";
import { defineAgent, findAction } from "./manifest.js";

const base = (): AgentManifest => ({
  id: "utilities",
  name: "Utilities Agent",
  version: "0.1.0",
  description: "Pays utility bills",
  capabilities: ["bills:read", "payments:request"],
  actions: [
    {
      name: "pay_bill",
      description: "Pay a bill",
      input: z.object({ accountRef: z.string() }),
      capability: "payments:request",
      effect: "payment",
    },
  ],
  settingsSchema: z.object({}),
});

const rejects = (m: AgentManifest, msg: RegExp) => {
  let err: unknown;
  try {
    defineAgent(m);
  } catch (e) {
    err = e;
  }
  expect(isHardwoodError(err, "invalid_input")).toBe(true);
  expect((err as Error).message).toMatch(msg);
};

describe("defineAgent", () => {
  it("accepts a valid manifest and finds actions", () => {
    const m = defineAgent(base());
    expect(findAction(m, "pay_bill")?.effect).toBe("payment");
    expect(findAction(m, "nope")).toBeUndefined();
  });

  it("rejects bad ids, versions and names", () => {
    rejects({ ...base(), id: "Utilities" }, /slug/);
    rejects({ ...base(), version: "1" }, /semver/);
    rejects({ ...base(), name: " " }, /name/);
    rejects({ ...base(), actions: [] }, /at least one action/);
  });

  it("rejects malformed and duplicate actions", () => {
    const [a] = base().actions;
    if (!a) throw new Error("fixture");
    rejects({ ...base(), actions: [{ ...a, name: "PayBill" }] }, /snake_case/);
    rejects({ ...base(), actions: [a, a] }, /duplicate/);
  });

  it("requires declared capabilities", () => {
    rejects({ ...base(), capabilities: ["bills:read"] }, /undeclared/);
  });

  it("never exposes payment execution as an action", () => {
    const m = base();
    m.capabilities.push("payments:execute");
    const [a] = m.actions;
    if (!a) throw new Error("fixture");
    rejects(
      { ...m, actions: [{ ...a, capability: "payments:execute" }] },
      /cannot be payments:execute/,
    );
    rejects({ ...m, actions: [{ ...a, capability: "bills:read" }] }, /must use payments:request/);
  });
});
