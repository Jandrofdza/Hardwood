import { canonicalJson, sha256 } from "./canonical.js";
import type { Actor } from "./run.js";
import { assertNoSecrets } from "./secrets.js";

export const GENESIS_HASH = "0".repeat(64);

export type AuditEntity = { type: string; id: string };

export type AuditInput = {
  actor: Actor;
  entity: AuditEntity;
  action: string;
  payload?: Record<string, unknown>;
};

/** Append-only. Each event commits to the previous one, so edits and gaps are detectable. */
export type AuditEvent = {
  seq: number;
  at: string;
  actor: Actor;
  entity: AuditEntity;
  action: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

export function hashAuditEvent(e: Omit<AuditEvent, "hash">): string {
  return sha256(
    canonicalJson({
      seq: e.seq,
      at: e.at,
      actor: e.actor,
      entity: e.entity,
      action: e.action,
      payload: e.payload,
      prevHash: e.prevHash,
    }),
  );
}

export function createAuditEvent(prev: AuditEvent | null, input: AuditInput, at: Date): AuditEvent {
  const payload = input.payload ?? {};
  assertNoSecrets(payload);
  const base = {
    seq: prev ? prev.seq + 1 : 1,
    at: at.toISOString(),
    actor: input.actor,
    entity: input.entity,
    action: input.action,
    payload,
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return { ...base, hash: hashAuditEvent(base) };
}

export type ChainVerification =
  | { ok: true; length: number }
  | { ok: false; seq: number; reason: "bad_hash" | "broken_link" | "bad_sequence" };

export function verifyAuditChain(events: readonly AuditEvent[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  for (const [i, e] of events.entries()) {
    if (e.seq !== i + 1) return { ok: false, seq: e.seq, reason: "bad_sequence" };
    if (e.prevHash !== prevHash) return { ok: false, seq: e.seq, reason: "broken_link" };
    if (hashAuditEvent(e) !== e.hash) return { ok: false, seq: e.seq, reason: "bad_hash" };
    prevHash = e.hash;
  }
  return { ok: true, length: events.length };
}
