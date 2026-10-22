import type { Cents, Currency } from "./money.js";

export type ConnectorMode = "mock" | "assisted" | "handoff" | "aggregator";

export type Bill = {
  billerId: string;
  accountRef: string;
  period: string;
  amountCents: Cents;
  currency: Currency;
  /** ISO date (YYYY-MM-DD). */
  dueDate: string;
  /** e.g. a línea de captura. */
  paymentReference?: string | undefined;
};

export type PaymentResult =
  | { status: "paid"; folio: string; amountCents: Cents; paidAt: string; receiptUrl?: string }
  /** Definitely not charged. */
  | { status: "declined"; reason: string }
  /** Timeout or lost response: maybe charged. Must be reconciled before anything else. */
  | { status: "unknown"; reason: string };

export type ChargeStatus =
  | { status: "charged"; folio: string; amountCents: Cents; paidAt: string; receiptUrl?: string }
  | { status: "not_charged" }
  | { status: "unknown" };

/**
 * One biller through one route. Connectors work from account references only; no
 * passwords or card data ever pass through this interface.
 */
export interface BillerConnector {
  readonly billerId: string;
  readonly mode: ConnectorMode;
  validateAccountRef(ref: string): boolean;
  lookup(accountRef: string): Promise<Bill | null>;
  /** Absent in modes where a human pays (assisted, handoff). */
  pay?(bill: Bill, idempotencyKey: string): Promise<PaymentResult>;
  /** Ask whether a payment with this key was charged. Needed to reconcile unknown outcomes. */
  checkPayment?(idempotencyKey: string): Promise<ChargeStatus>;
}
