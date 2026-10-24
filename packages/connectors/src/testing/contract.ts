import type { BillerConnector } from "@hardwood/agents-core";
import { describe, expect, it } from "vitest";

/**
 * Account references that produce each behaviour on the connector under test. Leave one
 * out when a mode cannot produce it (e.g. a handoff connector never times out); its
 * cases are skipped.
 */
export type ContractRefs = {
  payable: string;
  invalid: string;
  noBill?: string;
  declined?: string;
  timeoutCharged?: string;
  timeoutNotCharged?: string;
  amountChanged?: string;
};

/** Narrow a lookup result, failing the test if there is no bill. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a bill");
  return value;
}

let keyN = 0;
const key = () => `contract-key-${++keyN}`;

/**
 * Shared suite every connector mode runs: lookup, pay, timeout, amount changed and
 * duplicate key. `setup` must return a fresh connector each time.
 */
export function describeConnectorContract(
  name: string,
  setup: () => { connector: BillerConnector; refs: ContractRefs },
) {
  describe(`${name} connector contract`, () => {
    const { refs } = setup();
    const canPay = typeof setup().connector.pay === "function";

    it("rejects malformed account references", async () => {
      const { connector } = setup();
      expect(connector.validateAccountRef(refs.invalid)).toBe(false);
      expect(connector.validateAccountRef(refs.payable)).toBe(true);
      expect(await connector.lookup(refs.invalid)).toBeNull();
    });

    it("looks up a well-formed, stable bill", async () => {
      const { connector } = setup();
      const bill = await connector.lookup(refs.payable);
      expect(bill).not.toBeNull();
      expect(bill).toMatchObject({
        billerId: connector.billerId,
        accountRef: refs.payable,
        currency: "MXN",
      });
      expect(Number.isInteger(bill?.amountCents)).toBe(true);
      expect(bill?.amountCents).toBeGreaterThan(0);
      expect(bill?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(await connector.lookup(refs.payable)).toEqual(bill);
    });

    it.skipIf(!refs.noBill)("returns null when nothing is owed", async () => {
      const { connector } = setup();
      expect(await connector.lookup(refs.noBill ?? "")).toBeNull();
    });

    it.skipIf(!canPay)("pays an open bill and reports the charge", async () => {
      const { connector } = setup();
      const bill = await connector.lookup(refs.payable);
      const k = key();
      const result = await connector.pay?.(must(bill), k);
      expect(result).toMatchObject({ status: "paid", amountCents: bill?.amountCents });
      expect(await connector.checkPayment?.(k)).toMatchObject({ status: "charged" });
    });

    it.skipIf(!canPay)("never charges the same key twice", async () => {
      const { connector } = setup();
      const bill = await connector.lookup(refs.payable);
      const k = key();
      const first = await connector.pay?.(must(bill), k);
      const second = await connector.pay?.(must(bill), k);
      expect(second).toEqual(first);
      expect(await connector.checkPayment?.(key())).toEqual({ status: "not_charged" });
    });

    it.skipIf(!canPay || !refs.declined)("declines without charging", async () => {
      const { connector } = setup();
      const bill = await connector.lookup(refs.declined ?? "");
      const k = key();
      expect((await connector.pay?.(must(bill), k))?.status).toBe("declined");
      expect(await connector.checkPayment?.(k)).toEqual({ status: "not_charged" });
    });

    it.skipIf(!canPay || !refs.timeoutCharged)(
      "a timeout that charged reconciles as charged",
      async () => {
        const { connector } = setup();
        const bill = await connector.lookup(refs.timeoutCharged ?? "");
        const k = key();
        expect((await connector.pay?.(must(bill), k))?.status).toBe("unknown");
        expect((await connector.checkPayment?.(k))?.status).toBe("charged");
        // Retrying the same key reveals the charge instead of making another.
        expect((await connector.pay?.(must(bill), k))?.status).toBe("paid");
      },
    );

    it.skipIf(!canPay || !refs.timeoutNotCharged)(
      "a timeout that did not charge reconciles as not charged",
      async () => {
        const { connector } = setup();
        const bill = await connector.lookup(refs.timeoutNotCharged ?? "");
        const k = key();
        expect((await connector.pay?.(must(bill), k))?.status).toBe("unknown");
        expect(await connector.checkPayment?.(k)).toEqual({ status: "not_charged" });
      },
    );

    it.skipIf(!refs.amountChanged)(
      "reports a changed amount and refuses to pay the stale one",
      async () => {
        const { connector } = setup();
        const first = await connector.lookup(refs.amountChanged ?? "");
        const second = await connector.lookup(refs.amountChanged ?? "");
        expect(second?.amountCents).not.toBe(first?.amountCents);
        if (canPay) {
          const k = key();
          expect((await connector.pay?.(must(first), k))?.status).toBe("declined");
          expect(await connector.checkPayment?.(k)).toEqual({ status: "not_charged" });
          expect((await connector.pay?.(must(second), key()))?.status).toBe("paid");
        }
      },
    );
  });
}
