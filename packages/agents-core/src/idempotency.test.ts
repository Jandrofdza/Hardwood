import { describe, expect, it } from "vitest";
import { isHardwoodError } from "./errors.js";
import { assertIdempotencyKey, paymentKey, requestHash } from "./idempotency.js";

describe("idempotency", () => {
  it("builds one key per bill", () => {
    const k = paymentKey({
      workspaceId: "ws1",
      billerId: "cfe",
      accountRef: "123456789012",
      period: "2026-09",
    });
    expect(k).toBe("pay:ws1:cfe:123456789012:2026-09");
    expect(
      paymentKey({
        workspaceId: "ws1",
        billerId: "cfe",
        accountRef: "123456789012",
        period: "2026-10",
      }),
    ).not.toBe(k);
  });

  it("escapes separators so different bills never collide", () => {
    const a = paymentKey({ workspaceId: "ws:1", billerId: "cfe", accountRef: "1", period: "p" });
    const b = paymentKey({ workspaceId: "ws", billerId: "1:cfe", accountRef: "1", period: "p" });
    expect(a).not.toBe(b);
  });

  it("requires every part", () => {
    expect(() =>
      paymentKey({ workspaceId: "ws", billerId: "cfe", accountRef: " ", period: "p" }),
    ).toThrow(/accountRef/);
  });

  it("validates request keys", () => {
    expect(() => assertIdempotencyKey("abc")).toThrow();
    expect(() => assertIdempotencyKey("has space in it")).toThrow();
    expect(() => assertIdempotencyKey("req_2026-10-15:abc")).not.toThrow();
    try {
      assertIdempotencyKey("x");
    } catch (e) {
      expect(isHardwoodError(e, "invalid_input")).toBe(true);
    }
  });

  it("hashes requests canonically", () => {
    expect(requestHash("a", "b", { x: 1, y: 2 })).toBe(requestHash("a", "b", { y: 2, x: 1 }));
    expect(requestHash("a", "b", { x: 1 })).not.toBe(requestHash("a", "b", { x: 2 }));
  });
});
