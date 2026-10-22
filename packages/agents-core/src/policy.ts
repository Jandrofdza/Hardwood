import { z } from "zod";
import type { Cents } from "./money.js";
import { centsSchema } from "./money.js";

/** Per workspace + agent. v1 has one approval mode: every payment needs a human. */
export const policySchema = z.object({
  requireApprovalFor: z.literal("all_payments").default("all_payments"),
  approverRoles: z.array(z.string().min(1)).min(1),
  monthlyCapCents: centsSchema.optional(),
});
export type Policy = z.infer<typeof policySchema>;

export type PaymentDecision =
  | { decision: "requires_approval" }
  | {
      decision: "blocked";
      reason: "monthly_cap_exceeded";
      capCents: Cents;
      wouldSpendCents: Cents;
    };

/**
 * `committedCents` counts payments already made or in flight this month, so two runs
 * can't each fit under the cap and together exceed it.
 */
export function evaluatePayment(
  policy: Policy,
  amountCents: Cents,
  committedCents: Cents,
): PaymentDecision {
  const cap = policy.monthlyCapCents;
  const wouldSpend = committedCents + amountCents;
  if (cap !== undefined && wouldSpend > cap) {
    return {
      decision: "blocked",
      reason: "monthly_cap_exceeded",
      capCents: cap,
      wouldSpendCents: wouldSpend,
    };
  }
  return { decision: "requires_approval" };
}

export const canApprove = (policy: Policy, roles: readonly string[]) =>
  roles.some((r) => policy.approverRoles.includes(r));

/**
 * Calendar month in Mexico City time containing `at`, as UTC instants [from, to).
 * CDMX has been UTC-6 all year since DST was abolished in 2022.
 */
export function mexicoCityMonth(at: Date): { from: Date; to: Date } {
  const local = new Date(at.getTime() - 6 * 3600_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return {
    from: new Date(Date.UTC(y, m, 1, 6)),
    to: new Date(Date.UTC(y, m + 1, 1, 6)),
  };
}
