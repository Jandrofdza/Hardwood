import { describe, expect, it } from "vitest";
import { canApprove, evaluatePayment, mexicoCityMonth, policySchema } from "./policy.js";

const policy = policySchema.parse({ approverRoles: ["owner"], monthlyCapCents: 500_000 });

describe("policy", () => {
  it("defaults to approval for all payments", () => {
    expect(policySchema.parse({ approverRoles: ["owner"] }).requireApprovalFor).toBe(
      "all_payments",
    );
    expect(policySchema.safeParse({ approverRoles: [] }).success).toBe(false);
    expect(
      policySchema.safeParse({ approverRoles: ["owner"], requireApprovalFor: "none" }).success,
    ).toBe(false);
  });

  it("always requires approval under the cap, including exactly at it", () => {
    expect(evaluatePayment(policy, 100_000, 0)).toEqual({ decision: "requires_approval" });
    expect(evaluatePayment(policy, 100_000, 400_000)).toEqual({ decision: "requires_approval" });
  });

  it("blocks payments that would exceed the monthly cap", () => {
    expect(evaluatePayment(policy, 100_001, 400_000)).toEqual({
      decision: "blocked",
      reason: "monthly_cap_exceeded",
      capCents: 500_000,
      wouldSpendCents: 500_001,
    });
  });

  it("has no cap when none is set", () => {
    const open = policySchema.parse({ approverRoles: ["owner"] });
    expect(evaluatePayment(open, Number.MAX_SAFE_INTEGER, 0).decision).toBe("requires_approval");
  });

  it("checks approver roles", () => {
    expect(canApprove(policy, ["viewer", "owner"])).toBe(true);
    expect(canApprove(policy, ["viewer"])).toBe(false);
    expect(canApprove(policy, [])).toBe(false);
  });

  it("uses Mexico City calendar months", () => {
    // 2026-11-01 03:00 UTC is still Oct 31 21:00 in CDMX.
    const oct = mexicoCityMonth(new Date("2026-11-01T03:00:00Z"));
    expect(oct.from.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(oct.to.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    const nov = mexicoCityMonth(new Date("2026-11-01T06:00:00Z"));
    expect(nov.from.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    const dec = mexicoCityMonth(new Date("2026-12-31T12:00:00Z"));
    expect(dec.to.toISOString()).toBe("2027-01-01T06:00:00.000Z");
  });
});
