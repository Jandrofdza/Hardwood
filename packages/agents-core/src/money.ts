import { z } from "zod";

/** Integer centavos. Format only at the edge. */
export type Cents = number;

export const centsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const currencySchema = z.enum(["MXN"]);
export type Currency = z.infer<typeof currencySchema>;

export const DEFAULT_CURRENCY: Currency = "MXN";
