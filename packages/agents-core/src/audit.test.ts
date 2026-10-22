import { describe, expect, it } from "vitest";
import type { AuditEvent } from "./audit.js";
import { GENESIS_HASH, createAuditEvent, verifyAuditChain } from "./audit.js";
import { canonicalJson } from "./canonical.js";
import { isHardwoodError } from "./errors.js";

function chain(n: number): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      createAuditEvent(
        out.at(-1) ?? null,
        {
          actor: { type: "user", ref: "u1" },
          entity: { type: "run", id: `r${i}` },
          action: "run.start",
          payload: { i, nested: { b: 2, a: 1 } },
        },
        new Date(Date.UTC(2026, 9, 15, 18, 0, i)),
      ),
    );
  }
  return out;
}

describe("audit chain", () => {
  it("links events from the genesis hash", () => {
    const events = chain(3);
    expect(events[0]?.prevHash).toBe(GENESIS_HASH);
    expect(events[1]?.prevHash).toBe(events[0]?.hash);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(verifyAuditChain(events)).toEqual({ ok: true, length: 3 });
    expect(verifyAuditChain([])).toEqual({ ok: true, length: 0 });
  });

  it("detects an edited payload", () => {
    const events = chain(3);
    (events[1] as AuditEvent).payload = { i: 99 };
    expect(verifyAuditChain(events)).toEqual({ ok: false, seq: 2, reason: "bad_hash" });
  });

  it("detects a removed event", () => {
    const events = chain(3);
    events.splice(1, 1);
    expect(verifyAuditChain(events)).toMatchObject({ ok: false, reason: "bad_sequence" });
  });

  it("detects a rewritten event with a recomputed hash", () => {
    const events = chain(3);
    const forged = createAuditEvent(
      null,
      { actor: { type: "system" }, entity: { type: "run", id: "x" }, action: "forged" },
      new Date(),
    );
    events[1] = { ...forged, seq: 2 };
    expect(verifyAuditChain(events)).toMatchObject({ ok: false, seq: 2, reason: "broken_link" });
  });

  it("refuses secret-like fields", () => {
    let err: unknown;
    try {
      createAuditEvent(
        null,
        {
          actor: { type: "user" },
          entity: { type: "account", id: "a" },
          action: "x",
          payload: { portal: { Password: "hunter2" } },
        },
        new Date(),
      );
    } catch (e) {
      err = e;
    }
    expect(isHardwoodError(err, "secret_detected")).toBe(true);
  });

  it("hashes independent of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined }] })).toBe('{"a":[{"d":1}],"b":1}');
  });
});
