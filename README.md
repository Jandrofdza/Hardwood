# Hardwood

Hardwood makes every building smart: it knows everything about a building and acts on its owner's
behalf. This repo holds the platform and **Hardwood Agents**, a host-agnostic service that runs
agents as add-ins. See [`PLAN.md`](./PLAN.md) for the build plan and [`CLAUDE.md`](./CLAUDE.md) for
the rules.

## Layout

```
packages/agents-core   types, run state machine, policy, audit chain, connector interfaces
packages/agent-utilities  Utilities Agent: CFE, SACMEX, Predial CDMX; lookup and pay flows
packages/connectors    biller connectors by mode (mock today) + shared contract tests
tests/integration      cross-package flows, no database
apps/api               HTTP API + Postgres (Prisma)
apps/console           web UI (Next.js + Tailwind)
docs/adr               architecture decision records
```

## Getting started

Requires Node 22+, pnpm 10 and Postgres 16 (Docker or a local install).

```sh
pnpm i
cp .env.example .env
docker compose up db        # or point DATABASE_URL at any Postgres 16
pnpm db:migrate             # create tables
pnpm db:seed                # five demo buildings in Mexico City
pnpm dev                    # API on :4000, console on http://localhost:3000
```

## agents-core

`packages/agents-core` holds the framework-free core: agent manifests, the run state machine
(`run.ts`), the policy engine, payment idempotency, the hash-chained audit log, and
`AgentEngine`, which drives runs through request → approval → payment over storage ports. Import
`@hardwood/agents-core/testing` for the in-memory host used by the tests. Design notes are in
[ADR-003](docs/adr/003-agents-core-design.md).

## Utilities Agent (mock)

`packages/agent-utilities` defines the agent and its three billers; `UtilitiesRunner` looks bills
up and asks for approval, and the engine pays only approved runs. The mock connector in
`packages/connectors` chooses an outcome from the account reference's last digit: 0-4 pays,
5 is declined, 6 times out after charging, 7 times out without charging, 8 changes the amount,
9 owes nothing. Everything it returns is labeled `SIM`. See
[ADR-004](docs/adr/004-utilities-agent-and-mock-connector.md) and
`tests/integration/utilities-pay-flow.test.ts` for the full flow.

Checks:

```sh
pnpm test                   # unit tests; API database tests also run when TEST_DATABASE_URL is set
pnpm test:coverage
pnpm lint
pnpm typecheck
```
