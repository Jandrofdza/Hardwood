# ADR-004: Utilities Agent and the mock connector

- Status: accepted
- Date: 2026-10-24

## Context

Phase 2 adds the first agent and the first connector mode. The dependency rule says
`agent-utilities` and `connectors` import only `agents-core`, never each other.

## Decisions

1. **Billers live in the agent.** `agent-utilities` owns `cfe`, `sacmex` and `predial-cdmx`:
   names (in Spanish), the label owners see on the bill, and the account-reference format.
   Connectors are generic; the mock receives the biller's `validateAccountRef` when it is
   wired up. Apps (and `tests/integration`) do the wiring.
2. **Account-reference formats are format checks only**, after stripping spaces and dashes:
   CFE número de servicio 12 digits, SACMEX número de cuenta 16 digits, Predial CDMX cuenta
   predial 12 digits. Check digits and exceptions must be confirmed with each biller before a
   real connector exists.
3. **Periods are bimestres** (`YYYY-Bn`, Mexico City time) for all three billers. The payment
   key uses the normalized account reference, so `035-123-45-000-4` and `035123450004` are the
   same bill.
4. **`pay_bill` takes `{ billerId, accountRef, period? }`.** Until bills are stored (Phase 3),
   the run looks up the open bill itself. `period` pins the bill the owner meant; a different
   open period fails the run instead of paying something else.
5. **`UtilitiesRunner` drives runs deterministically.** It looks bills up and proposes
   payments; paying always goes through `AgentEngine.execute`, which refuses unapproved runs.
   Connector error text is not copied into run history.
6. **The mock picks its scenario from the account reference's last digit** (0-4 pays, 5
   declined, 6 timeout after charging, 7 timeout without charging, 8 amount changes after the
   first lookup, 9 nothing owed), overridable per account. Bills are a pure function of biller,
   account and clock. Everything is labeled: folios and líneas de captura start with `SIM`,
   receipts use `sim://` URLs. No login, password or card fields exist.
7. **A key that charged replays its charge; nothing else is cached.** The mock never charges
   a key twice, but a declined or uncharged attempt can be retried.
8. **Shared contract suite.** `@hardwood/connectors/testing` exports
   `describeConnectorContract`; every connector mode runs it. Cases a mode cannot produce
   (e.g. timeouts in handoff) are skipped by leaving out their account reference.
9. **Tests read workspace packages from source.** Package exports carry a `source` condition
   (TypeScript `customConditions`) and vitest aliases, so `pnpm test` and `pnpm typecheck`
   need no build; `tsconfig.build.json` turns the condition off so builds use published types.
