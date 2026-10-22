# ADR-002: v1 is a buildings database and a read-only console

- Status: accepted
- Date: 2026-10-22

## Context

Before agents can act on a building, Hardwood has to know the building. The first usable version
should be small: a few buildings in Mexico City, stored in a database, with a front end that shows
basic facts.

## Decision

- `Building` table in Postgres via Prisma 7 (driver adapter `@prisma/adapter-pg`), seeded with five
  fictional demo buildings in real colonias of Cuauhtémoc, Miguel Hidalgo and Benito Juárez.
- `apps/api` (Hono) serves `GET /v1/buildings` and `GET /v1/buildings/:idOrSlug`. Read-only and
  unauthenticated for now; API keys arrive with the rest of the API in Phase 3.
- `apps/console` (Next.js 16, Tailwind 4) renders on the server and reads from the API only, never
  from the database, so it already behaves like a host ("host #0").
- Facts kept to what an owner would recognize: address, use, year built, floors, units, areas,
  parking, elevators, coordinates.

## Consequences

- When the Utilities Agent arrives, `UtilityAccount.propertyRef` can point at a building id, but
  hosts may use their own property ids instead; the agents service does not depend on `Building`.
- The console duplicates the API's building types until `client-sdk` exists (Phase 8).
