import { describe, expect, it } from "vitest";
import {
  BILLERS,
  BILLER_IDS,
  bimestreOf,
  isValidAccountRef,
  normalizeAccountRef,
  periodSchema,
} from "./billers.js";
import { billTargetSchema, utilitiesAgent } from "./manifest.js";
import { defineAgent } from "@hardwood/agents-core";

describe("billers", () => {
  it("covers CFE, SACMEX and Predial CDMX with Spanish names", () => {
    expect(BILLER_IDS).toEqual(["cfe", "sacmex", "predial-cdmx"]);
    expect(BILLERS.cfe.accountRefLabel).toBe("Número de servicio");
    expect(BILLERS["predial-cdmx"].name).toMatch(/Tesorería/);
  });

  it.each([
    ["cfe", "123456789012", true],
    ["cfe", "1234 5678 9012", true],
    ["cfe", "12345678901", false],
    ["cfe", "12345678901a", false],
    ["sacmex", "1234567890123456", true],
    ["sacmex", "123456789012", false],
    ["predial-cdmx", "035-123-45-000-6", true],
    ["predial-cdmx", "035123450006", true],
    ["predial-cdmx", "035-123-45", false],
  ] as const)("%s accepts %s: %s", (biller, ref, ok) => {
    expect(isValidAccountRef(biller, ref)).toBe(ok);
  });

  it("normalizes references", () => {
    expect(normalizeAccountRef(" 035-123-45-000-6 ")).toBe("035123450006");
  });

  it("names bimonthly periods in Mexico City time", () => {
    expect(bimestreOf(new Date("2026-10-15T18:00:00Z"))).toBe("2026-B5");
    expect(bimestreOf(new Date("2027-01-01T05:00:00Z"))).toBe("2026-B6");
    expect(bimestreOf(new Date("2027-01-01T06:00:00Z"))).toBe("2027-B1");
    expect(periodSchema.safeParse("2026-B7").success).toBe(false);
  });
});

describe("utilities manifest", () => {
  it("is a valid manifest with one read and one payment action", () => {
    const m = defineAgent(utilitiesAgent);
    expect(m.actions.map((a) => [a.name, a.effect])).toEqual([
      ["lookup_bill", "read"],
      ["pay_bill", "payment"],
    ]);
  });

  it("validates and normalizes the bill target", () => {
    expect(
      billTargetSchema.parse({ billerId: "predial-cdmx", accountRef: "035-123-45-000-6" }),
    ).toEqual({
      billerId: "predial-cdmx",
      accountRef: "035123450006",
    });
    expect(billTargetSchema.safeParse({ billerId: "cfe", accountRef: "123" }).success).toBe(false);
    expect(
      billTargetSchema.safeParse({ billerId: "telmex", accountRef: "123456789012" }).success,
    ).toBe(false);
    expect(
      billTargetSchema.safeParse({ billerId: "cfe", accountRef: "123456789012", password: "x" })
        .success,
    ).toBe(false);
    expect(
      billTargetSchema.safeParse({ billerId: "cfe", accountRef: "123456789012", period: "2026-B5" })
        .success,
    ).toBe(true);
  });

  it("defaults settings", () => {
    expect(utilitiesAgent.settingsSchema.parse({})).toEqual({ notifyDaysBeforeDue: 5 });
  });
});
