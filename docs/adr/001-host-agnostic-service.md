# ADR-001: Hardwood Agents is a host-agnostic service plus packages

- Status: accepted
- Date: 2026-10-22

## Context

Hardwood runs agents (first: the Utilities Agent) on behalf of building owners. Several apps
("hosts") will use it: Hardwood's own console first, then Gestio, Orb and others. PLAN.md section
10, decision #1, asks whether Hardwood ships as a service that hosts call, or only as packages
that hosts embed.

## Decision

Ship both, with the service as the primary product:

- `apps/api` is the Hardwood Agents service. Hosts call it over HTTP with API keys and receive
  signed webhooks. It owns the database, the jobs and the audit log.
- `packages/*` hold the logic (`agents-core`, agents, connectors, `llm`) so it is testable without
  a database or HTTP, and so a typed `client-sdk` can follow in Phase 8.
- Hosts are referenced only by opaque `externalRef` strings. No host code, data model or naming
  enters this repo.

Dependency direction, enforced by ESLint and by `scripts/dependency-rules.test.ts`:
`agents-core` imports no internal package; agents and connectors import only `agents-core`; apps
import packages and never the reverse.

## Consequences

- One deployment holds money-moving logic, approvals and the audit chain, instead of every host
  re-implementing them.
- Hosts depend on the service's availability; webhooks need retries and a delivery log (Phase 3).
- Hosting (decision #4) is deferred: Phase 0 to Phase 2 run locally against Postgres 16
  (`docker compose up db`). The stack is plain Node + Postgres so any of Fly, Railway, Render or
  AWS work later; serverless-only hosting is less suitable because of the Postgres-backed job
  queue (pg-boss).
- Node 22 LTS instead of the Node 20 named in PLAN.md: Node 20 reached end of life in April 2026.
