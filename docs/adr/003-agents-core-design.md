# ADR-003: agents-core run engine

- Status: accepted
- Date: 2026-10-22

## Context

Phase 1 builds `agents-core`: the run state machine, policy, idempotency and audit chain, with
no database, HTTP or LLM. PLAN.md sketches the types; this records where the implementation
makes a call the plan left open, or differs from it.

## Decisions

1. **Pure state machine + engine over ports.** `run.ts` is a transition table. `AgentEngine`
   orchestrates through a `Store` port (with `transaction`), an `EventSink`, a `Clock` and an id
   generator. `testing/InMemoryStore` gives the guarantees the Postgres store must give: unique
   keys, optimistic versions, serialized transactions, rollback on error.
2. **`executing` cannot be cancelled.** PLAN.md says any non-terminal state can be cancelled.
   Once a charge may be in flight, cancelling would hide money that moved. Turning an add-in off
   or the kill switch cancels `queued`, `running` and `awaiting_approval`; `executing` finishes.
3. **Approvals are bound to an amount.** An approval stores the amount it approves. A changed
   amount (at execution or on refresh) supersedes it and opens a new one; approving a stale
   approval id fails.
4. **Payment claim before payment.** The `(workspaceId, billerId, accountRef, period)` key is
   claimed in the store (unique) before the connector's `pay` is called. A failed payment frees
   the claim; a pending or unknown one blocks every other attempt. A retry that finds its own
   claim never pays again; it goes to reconciliation.
5. **Unknown outcomes reconcile.** A timeout or thrown error leaves the run `executing` with
   `reconciliation: "pending"`. It becomes `failed` only when the connector confirms no charge.
6. **Monthly cap in centavos** (`monthlyCapCents`, not `monthlyCapMXN`), per the money
   convention. It counts paid and in-flight payments in the Mexico City calendar month, and is
   checked at proposal, at approval and on an amount change.
7. **Events after commit.** Webhook events collected inside a transaction are emitted only after
   it commits. The API will back the sink with an outbox table.
8. **Biller ids are strings in core.** The `cfe | sacmex | predial-cdmx` union belongs to the
   Utilities Agent, so core stays agent-agnostic.
9. **Secret guard by field name.** Audit payloads, step data, run input and settings are rejected
   if they carry fields like `password`, `clabe`, `cardNumber` or `cvv`. Matching on names, not
   digit patterns, because account references are long digit strings too.
10. **No action can be `payments:execute`.** Manifests are validated so execution is never
    something a caller (or a model) can request; only the engine pays, after approval.
