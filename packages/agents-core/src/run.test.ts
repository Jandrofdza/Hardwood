import { describe, expect, it } from "vitest";
import { isHardwoodError } from "./errors.js";
import type { RunEvent, RunState } from "./run.js";
import {
  RUN_EVENTS,
  RUN_STATES,
  TERMINAL_STATES,
  canTransition,
  isTerminal,
  nextState,
} from "./run.js";

// Written out independently of TRANSITIONS so a change to the machine must change both.
const EXPECTED: Record<string, RunState> = {
  "queued.start": "running",
  "queued.cancel": "cancelled",
  "running.propose": "awaiting_approval",
  "running.complete": "succeeded",
  "running.fail": "failed",
  "running.cancel": "cancelled",
  "awaiting_approval.approve": "executing",
  "awaiting_approval.reject": "rejected",
  "awaiting_approval.amount_changed": "awaiting_approval",
  "awaiting_approval.cancel": "cancelled",
  "executing.succeed": "succeeded",
  "executing.fail": "failed",
  "executing.amount_changed": "awaiting_approval",
};

describe("run state machine", () => {
  const pairs = RUN_STATES.flatMap((s) => RUN_EVENTS.map((e) => [s, e] as [RunState, RunEvent]));

  it.each(pairs)("%s + %s", (state, event) => {
    const expected = EXPECTED[`${state}.${event}`];
    expect(canTransition(state, event)).toBe(expected !== undefined);
    if (expected) {
      expect(nextState(state, event)).toBe(expected);
    } else {
      let err: unknown;
      try {
        nextState(state, event);
      } catch (e) {
        err = e;
      }
      expect(isHardwoodError(err, "invalid_transition")).toBe(true);
    }
  });

  it("terminal states have no way out", () => {
    for (const s of TERMINAL_STATES) {
      expect(isTerminal(s)).toBe(true);
      expect(RUN_EVENTS.filter((e) => canTransition(s, e))).toEqual([]);
    }
    expect(RUN_STATES.filter((s) => !isTerminal(s))).toEqual([
      "queued",
      "running",
      "awaiting_approval",
      "executing",
    ]);
  });

  it("executing cannot be cancelled while a charge may be in flight", () => {
    expect(canTransition("executing", "cancel")).toBe(false);
  });

  it("every non-terminal state can reach a terminal state", () => {
    for (const start of RUN_STATES) {
      const seen = new Set<RunState>([start]);
      const queue = [start];
      while (queue.length) {
        const s = queue.shift() as RunState;
        for (const e of RUN_EVENTS) {
          const to = canTransition(s, e) ? nextState(s, e) : undefined;
          if (to && !seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
        }
      }
      expect([...seen].some(isTerminal)).toBe(true);
    }
  });
});
