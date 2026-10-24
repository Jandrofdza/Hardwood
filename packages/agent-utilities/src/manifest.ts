import type { AgentManifest } from "@hardwood/agents-core";
import { z } from "zod";
import { billerIdSchema, isValidAccountRef, normalizeAccountRef, periodSchema } from "./billers.js";

/** Which bill: a biller and the owner's account reference there. */
export const billTargetSchema = z
  .object({
    billerId: billerIdSchema,
    accountRef: z.string().min(1).max(40),
    /** Optional: pay only if the open bill is for this period. */
    period: periodSchema.optional(),
  })
  .strict()
  .refine((v) => isValidAccountRef(v.billerId, v.accountRef), {
    message: "account reference has the wrong format for this biller",
    path: ["accountRef"],
  })
  .transform((v) => ({ ...v, accountRef: normalizeAccountRef(v.accountRef) }));
export type BillTarget = z.output<typeof billTargetSchema>;

export const utilitiesSettingsSchema = z
  .object({
    /** Remind the owner this many days before a bill is due. */
    notifyDaysBeforeDue: z.number().int().min(0).max(60).default(5),
  })
  .strict();
export type UtilitiesSettings = z.output<typeof utilitiesSettingsSchema>;

export const utilitiesAgent: AgentManifest = {
  id: "utilities",
  name: "Utilities Agent",
  version: "0.1.0",
  description:
    "Finds what a property owes for electricity (CFE), water (SACMEX) and property tax " +
    "(Predial CDMX), asks a human to approve, pays, and keeps the receipt.",
  capabilities: ["accounts:read", "bills:read", "payments:request", "payments:execute"],
  actions: [
    {
      name: "lookup_bill",
      description: "Fetch the current open bill for an account.",
      input: billTargetSchema,
      capability: "bills:read",
      effect: "read",
    },
    {
      name: "pay_bill",
      description: "Find the open bill for an account and request approval to pay it.",
      input: billTargetSchema,
      capability: "payments:request",
      effect: "payment",
    },
  ],
  settingsSchema: utilitiesSettingsSchema,
};
