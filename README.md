# Hardwood

Hardwood makes every building smart: it knows everything about a building and acts on its owner's
behalf. This repo holds the platform and **Hardwood Agents**, a host-agnostic service that runs
agents as add-ins. See [`PLAN.md`](./PLAN.md) for the build plan and [`CLAUDE.md`](./CLAUDE.md) for
the rules.

## Layout

```
packages/agents-core   types, run state machine, policy, audit chain, connector interfaces
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
pnpm test                   # all unit tests; API DB tests run when TEST_DATABASE_URL is set
pnpm lint
pnpm typecheck
```
