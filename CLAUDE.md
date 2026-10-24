# Hardwood

Hardwood is a platform for making every building smart: knowing everything about a building and taking actions on its owner's behalf. This repo starts with **Hardwood Agents**, a host-agnostic service that runs agents as add-ins (first: the Utilities Agent, which pays electricity, water and property tax).

The full build plan is in [`PLAN.md`](./PLAN.md). Read it before changing anything.

## Rules

- **The model never executes a payment.** LLM code can read and request; only deterministic code executes, and only after an approval.
- **Every payment needs a human approval** (v1). Idempotency key with a unique constraint on every payment.
- **Host-agnostic.** No Gestio (or any host) code, models or naming. Hosts are referenced by opaque `externalRef` strings.
- **Dependency direction:** `agents-core` imports no other package; agents and connectors import only `agents-core`; apps import packages.
- **Audit every state change** to the hash-chained audit log.
- **No secrets in prompts, logs or fixtures.** No portal passwords, card numbers or CLABEs anywhere.
- **Simulations look like simulations.** Mock portals carry a visible "Simulation" label and never copy real logos, colors, URLs or login/card fields.

## Conventions

- TypeScript strict, ESM, zod for every external input, vitest for tests.
- Code and docs in English. UI copy in English for now; biller and legal names stay in Spanish (CFE, SACMEX, Predial CDMX, línea de captura).
- Money: integer centavos in code (`amountCents`), MXN by default; format only at the edge.
- Dates: store UTC, display America/Mexico_City.
- One branch per phase (`phase-0-scaffold`, `phase-1-core`, …). Stop for review after each phase.
- Record significant choices as short ADRs in `docs/adr/`.

## Commands

- `pnpm i`: install (also generates the Prisma client)
- `docker compose up db`: local Postgres 16; then `pnpm db:migrate` and `pnpm db:seed`
- `pnpm dev`: API on :4000, console on :3000
- `pnpm test`: all tests; API database tests also run when `TEST_DATABASE_URL` is set
- `pnpm test:coverage`, `pnpm lint`, `pnpm typecheck`, `pnpm build`
