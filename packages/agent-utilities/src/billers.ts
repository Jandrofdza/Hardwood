import { z } from "zod";

export const BILLER_IDS = ["cfe", "sacmex", "predial-cdmx"] as const;
export type BillerId = (typeof BILLER_IDS)[number];
export const billerIdSchema = z.enum(BILLER_IDS);

export type Biller = {
  id: BillerId;
  /** Legal / brand name, kept in Spanish. */
  name: string;
  service: "electricity" | "water" | "property_tax";
  /** What the owner calls the account reference on their bill. */
  accountRefLabel: string;
  /** Digits only, after `normalizeAccountRef`. */
  accountRefDigits: number;
};

/**
 * Account reference formats as printed on bills. These are format checks only; check
 * digits and edge cases must be confirmed with each biller before a real connector.
 * Predial: a property in Alcaldía Miguel Hidalgo pays the CDMX Tesorería, hence
 * `predial-cdmx`.
 */
export const BILLERS: Record<BillerId, Biller> = {
  cfe: {
    id: "cfe",
    name: "CFE (Comisión Federal de Electricidad)",
    service: "electricity",
    accountRefLabel: "Número de servicio",
    accountRefDigits: 12,
  },
  sacmex: {
    id: "sacmex",
    name: "SACMEX (Sistema de Aguas de la Ciudad de México)",
    service: "water",
    accountRefLabel: "Número de cuenta",
    accountRefDigits: 16,
  },
  "predial-cdmx": {
    id: "predial-cdmx",
    name: "Predial CDMX (Tesorería de la Ciudad de México)",
    service: "property_tax",
    accountRefLabel: "Cuenta predial",
    accountRefDigits: 12,
  },
};

/** Owners type references with spaces and dashes (e.g. 035-123-45-000-6). */
export const normalizeAccountRef = (ref: string) => ref.replace(/[\s-]/g, "");

export function isValidAccountRef(billerId: BillerId, ref: string): boolean {
  const digits = normalizeAccountRef(ref);
  return new RegExp(`^\\d{${BILLERS[billerId].accountRefDigits}}$`).test(digits);
}

/** All three bill bimonthly: `YYYY-Bn`, n = 1..6 (bimestre). */
export const periodSchema = z.string().regex(/^\d{4}-B[1-6]$/, "period must look like 2026-B5");

/** Bimestre containing `at`, in Mexico City time (UTC-6). */
export function bimestreOf(at: Date): string {
  const local = new Date(at.getTime() - 6 * 3600_000);
  return `${local.getUTCFullYear()}-B${Math.floor(local.getUTCMonth() / 2) + 1}`;
}
