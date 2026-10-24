import type {
  Bill,
  BillerConnector,
  ChargeStatus,
  ConnectorMode,
  PaymentResult,
} from "@hardwood/agents-core";

export const MOCK_SCENARIOS = [
  "success",
  "declined",
  "timeout_charged",
  "timeout_not_charged",
  "amount_changed",
  "no_bill",
  "lookup_error",
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/**
 * Demo convention so anyone can pick an outcome by typing an account reference:
 * last digit 0-4 pays, 5 is declined, 6 times out after charging, 7 times out without
 * charging, 8 changes the amount after the first lookup, 9 has no open bill.
 */
export function scenarioByLastDigit(accountRef: string): MockScenario {
  const d = Number(accountRef.at(-1));
  if (Number.isNaN(d) || d <= 4) return "success";
  return (
    (["declined", "timeout_charged", "timeout_not_charged", "amount_changed", "no_bill"] as const)[
      d - 5
    ] ?? "success"
  );
}

export type MockConnectorOptions = {
  billerId: string;
  /** The biller's account-reference rule, supplied by the agent that owns the biller. */
  validateAccountRef: (ref: string) => boolean;
  now?: () => Date;
  /** Per-account overrides of `scenarioByLastDigit`. */
  scenarios?: Record<string, MockScenario>;
  /** Generated bill amounts fall in [min, max] centavos. */
  amountRange?: [number, number];
  /** Added to the amount on lookups after the first, in the amount_changed scenario. */
  amountChangeCents?: number;
  /** Billing period for a bill looked up at `now`. Defaults to the CDMX bimestre (YYYY-Bn). */
  periodOf?: (now: Date) => string;
};

export type MockCharge = {
  paymentKey: string;
  accountRef: string;
  amountCents: number;
  folio: string;
  paidAt: string;
};

const SIM_PREFIX = "SIM";

/**
 * Deterministic fake biller: same inputs, same bills, receipts and failures. Everything it
 * produces is labeled as a simulation (folios and references start with SIM, receipts use
 * a sim:// URL). It never asks for credentials or card data.
 */
export class MockBillerConnector implements BillerConnector {
  readonly mode: ConnectorMode = "mock";
  readonly billerId: string;
  /** Every charge actually made, for tests and the console's simulation panel. */
  readonly charges: MockCharge[] = [];

  private readonly opts: Required<Omit<MockConnectorOptions, "scenarios">> & {
    scenarios: Record<string, MockScenario>;
  };
  private readonly lookups = new Map<string, number>();

  constructor(options: MockConnectorOptions) {
    this.billerId = options.billerId;
    this.opts = {
      now: () => new Date(),
      scenarios: {},
      amountRange: [20_000, 300_000],
      amountChangeCents: 3_550,
      periodOf: cdmxBimestre,
      ...options,
    };
  }

  scenarioFor(accountRef: string): MockScenario {
    return this.opts.scenarios[accountRef] ?? scenarioByLastDigit(accountRef);
  }

  validateAccountRef(ref: string): boolean {
    return this.opts.validateAccountRef(ref);
  }

  async lookup(accountRef: string): Promise<Bill | null> {
    if (!this.validateAccountRef(accountRef)) return null;
    const scenario = this.scenarioFor(accountRef);
    if (scenario === "lookup_error") throw new Error("simulated biller outage");
    if (scenario === "no_bill") return null;
    const n = (this.lookups.get(accountRef) ?? 0) + 1;
    this.lookups.set(accountRef, n);
    return this.currentBill(accountRef, scenario === "amount_changed" && n > 1);
  }

  async pay(bill: Bill, paymentKey: string): Promise<PaymentResult> {
    // A key that already charged replays that charge; it is never charged twice.
    // Outcomes that charged nothing are recomputed, so a later attempt can go through.
    const previous = this.chargeFor(paymentKey);
    if (previous) return { ...previous, status: "paid" };
    return this.charge(bill, paymentKey);
  }

  async checkPayment(paymentKey: string): Promise<ChargeStatus> {
    return this.chargeFor(paymentKey) ?? { status: "not_charged" };
  }

  private chargeFor(paymentKey: string) {
    const c = this.charges.find((x) => x.paymentKey === paymentKey);
    if (!c) return null;
    return {
      status: "charged" as const,
      folio: c.folio,
      amountCents: c.amountCents,
      paidAt: c.paidAt,
      receiptUrl: receiptUrl(c.folio),
    };
  }

  private charge(bill: Bill, paymentKey: string): PaymentResult {
    if (bill.billerId !== this.billerId || !this.validateAccountRef(bill.accountRef)) {
      return { status: "declined", reason: "unknown account" };
    }
    const scenario = this.scenarioFor(bill.accountRef);
    if (scenario === "declined") return { status: "declined", reason: "simulated decline" };
    if (scenario === "no_bill" || scenario === "lookup_error") {
      return { status: "declined", reason: "no open bill" };
    }
    const open = this.currentBill(
      bill.accountRef,
      scenario === "amount_changed" && (this.lookups.get(bill.accountRef) ?? 0) > 1,
    );
    if (bill.period !== open.period || bill.amountCents !== open.amountCents) {
      return { status: "declined", reason: "amount does not match the open bill" };
    }
    if (scenario === "timeout_not_charged")
      return { status: "unknown", reason: "simulated timeout" };

    const folio = `${SIM_PREFIX}-${this.billerId.toUpperCase()}-${String(this.charges.length + 1).padStart(6, "0")}`;
    const paidAt = this.opts.now().toISOString();
    this.charges.push({
      paymentKey,
      accountRef: bill.accountRef,
      amountCents: bill.amountCents,
      folio,
      paidAt,
    });
    if (scenario === "timeout_charged") return { status: "unknown", reason: "simulated timeout" };
    return {
      status: "paid",
      folio,
      amountCents: bill.amountCents,
      paidAt,
      receiptUrl: receiptUrl(folio),
    };
  }

  private currentBill(accountRef: string, changed: boolean): Bill {
    const now = this.opts.now();
    const [min, max] = this.opts.amountRange;
    const h = fnv1a(`${this.billerId}:${accountRef}`);
    const base = min + (h % (max - min + 1));
    const due = new Date(now.getTime() + 15 * 86_400_000);
    return {
      billerId: this.billerId,
      accountRef,
      period: this.opts.periodOf(now),
      amountCents: changed ? base + this.opts.amountChangeCents : base,
      currency: "MXN",
      dueDate: due.toISOString().slice(0, 10),
      paymentReference: `${SIM_PREFIX}-LC-${h.toString(36).toUpperCase().padStart(7, "0")}`,
    };
  }
}

const receiptUrl = (folio: string) => `sim://receipts/${folio}`;

function cdmxBimestre(at: Date): string {
  const local = new Date(at.getTime() - 6 * 3600_000);
  return `${local.getUTCFullYear()}-B${Math.floor(local.getUTCMonth() / 2) + 1}`;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
