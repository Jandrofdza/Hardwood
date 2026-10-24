import { describe, expect, it } from "vitest";
import { MockBillerConnector, scenarioByLastDigit } from "./mock.js";
import { describeConnectorContract, must } from "./testing/index.js";

const twelveDigits = (ref: string) => /^\d{12}$/.test(ref);
const now = () => new Date("2026-10-15T18:00:00Z");
const make = (scenarios = {}) =>
  new MockBillerConnector({ billerId: "cfe", validateAccountRef: twelveDigits, now, scenarios });

describeConnectorContract("mock", () => ({
  connector: make(),
  refs: {
    payable: "123456789010",
    invalid: "12-34",
    declined: "123456789015",
    timeoutCharged: "123456789016",
    timeoutNotCharged: "123456789017",
    amountChanged: "123456789018",
    noBill: "123456789019",
  },
}));

describe("mock connector", () => {
  it("maps the last digit to a scenario", () => {
    expect(
      ["0", "4", "5", "6", "7", "8", "9", "x"].map((d) => scenarioByLastDigit(`12345678901${d}`)),
    ).toEqual([
      "success",
      "success",
      "declined",
      "timeout_charged",
      "timeout_not_charged",
      "amount_changed",
      "no_bill",
      "success",
    ]);
  });

  it("is deterministic across instances", async () => {
    const a = await make().lookup("123456789010");
    const b = await make().lookup("123456789010");
    expect(a).toEqual(b);
    expect(a).toMatchObject({ period: "2026-B5", dueDate: "2026-10-30" });
    expect(a?.paymentReference).toMatch(/^SIM-LC-/);
  });

  it("labels everything as a simulation", async () => {
    const c = make();
    const bill = await c.lookup("123456789010");
    const paid = await c.pay(must(bill), "sim-key-1");
    expect(paid).toMatchObject({
      status: "paid",
      folio: "SIM-CFE-000001",
      receiptUrl: "sim://receipts/SIM-CFE-000001",
    });
  });

  it("supports explicit scenarios, including an outage", async () => {
    const c = make({ "123456789010": "lookup_error" });
    await expect(c.lookup("123456789010")).rejects.toThrow(/simulated/);
    expect(c.scenarioFor("123456789011")).toBe("success");
  });

  it("refuses bills for other billers or accounts", async () => {
    const c = make();
    const bill = await c.lookup("123456789010");
    expect(await c.pay({ ...must(bill), billerId: "sacmex" }, "k-other-1")).toMatchObject({
      status: "declined",
    });
    expect(await c.pay({ ...must(bill), period: "2026-B4" }, "k-other-2")).toMatchObject({
      status: "declined",
    });
    expect(c.charges).toHaveLength(0);
  });

  it("counts real charges only", async () => {
    const c = make();
    const ok = await c.lookup("123456789010");
    await c.pay(must(ok), "k1");
    await c.pay(must(ok), "k1");
    const declined = await c.lookup("123456789015");
    await c.pay(must(declined), "k2");
    expect(c.charges.map((x) => x.paymentKey)).toEqual(["k1"]);
  });
});
