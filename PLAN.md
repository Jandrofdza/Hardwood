# Hardwood Agents — Build Plan

> Hand this to Claude Code in the `Jandrofdza/Hardwood` repo (empty today). Read together with `CLAUDE.md`.

## 1. What we're building

**Hardwood Agents** is a standalone service that runs agents acting on behalf of building owners. Agents are **add-ins**: each one is a package with a manifest, and each customer workspace turns them on and off.

The first agent is the **Utilities Agent**: it finds what a property owes for electricity (CFE), water (SACMEX) and property tax (predial CDMX), asks a human to approve, pays, and stores the receipt.

Hardwood is **host-agnostic**. It knows nothing about Gestio, Orb or any other app. Apps ("hosts") connect over an API, receive webhooks, and later use an SDK. Gestio is the first host we'll integrate, **but not in this plan** (see Phase 8, out of scope for now). Nothing in this repo may import or assume Gestio code, models or naming.

## 2. Principles (non-negotiable)

1. **Code moves money, never the model.** An LLM can look things up and *request* a payment. Only deterministic code executes a payment, and only after approval.
2. **Every payment needs human approval in v1.** Auto-pay under a limit comes later through the policy engine.
3. **Idempotent everything.** A bill is paid at most once: unique key `(workspaceId, billerId, accountRef, period)`. Every mutating API call accepts an `Idempotency-Key` header.
4. **No secrets in prompts or logs.** Connectors work from account references (número de servicio, cuenta SACMEX, cuenta predial). Any secret is encrypted at rest and never enters model context.
5. **Append-only, hash-chained audit log** for every state change, with the actor (`user`, `agent`, `system`, `host`).
6. **Off means off.** Disabling an add-in blocks new runs and cancels queued ones. A global kill switch disables an agent for every workspace.
7. **Host-agnostic.** Hosts refer to their own records by opaque `externalRef` strings. Hardwood stores those refs, never host data models.
8. **No look-alike portals.** Mock biller pages and fixtures are plainly labeled simulations: no real logos, colors, URLs, or login/card fields.

## 3. Repo layout (pnpm monorepo, TypeScript)

```
hardwood/
  packages/
    agents-core/          framework-free: types, run state machine, policy engine, audit chain,
                          connector + agent interfaces. No DB, no HTTP, no LLM.
    agent-utilities/      the Utilities Agent: manifest, billers (cfe, sacmex, predial-cdmx),
                          lookup/pay flows, account-ref validation
    connectors/           biller connectors by mode: mock, assisted, handoff (aggregator later)
    llm/                  tool definitions + Claude wrapper; turns plain language into run requests
    client-sdk/           (Phase 8) typed client for hosts
  apps/
    api/                  the Hardwood Agents service: HTTP API, DB, jobs, webhooks
    console/              Hardwood's own web UI: add-ins, accounts, bills, runs, approvals.
                          Doubles as the demo and as "host #0"
    mcp/                  (Phase 6) MCP server exposing agent tools to any host's AI assistant
  docs/
    adr/                  short architecture decision records
```

**Stack:** Node 20, TypeScript strict, pnpm workspaces, zod, vitest. API: Hono (or Fastify). DB: Postgres + Prisma. Jobs: pg-boss (Postgres-backed, no Redis). Console: Next.js + Tailwind. LLM: Anthropic SDK with the model id in an env var. Local dev: Docker Compose for Postgres.

Dependency rule: `agents-core` imports nothing from the other packages; `agent-utilities` and `connectors` import only `agents-core`; apps import packages, never the reverse. Enforce with a lint rule or a test.

## 4. Core concepts

```ts
type AgentManifest = {
  id: string;                      // "utilities"
  name: string;                    // "Utilities Agent"
  version: string;
  description: string;
  capabilities: Capability[];      // "bills:read" | "payments:request" | "payments:execute" | ...
  actions: ActionDef[];            // e.g. lookup_bill, pay_bill — each with zod input schema
  settingsSchema: ZodSchema;       // e.g. { notifyDaysBeforeDue, monthlyCapMXN }
};

type RunState =
  | "queued" | "running" | "awaiting_approval" | "executing"
  | "succeeded" | "failed" | "rejected" | "cancelled";

interface BillerConnector {
  billerId: "cfe" | "sacmex" | "predial-cdmx";
  mode: "mock" | "assisted" | "handoff" | "aggregator";
  validateAccountRef(ref: string): boolean;
  lookup(ref: string): Promise<Bill | null>;
  pay(bill: Bill, idempotencyKey: string): Promise<PaymentResult>; // not all modes support this
}

interface Policy {                 // per workspace + agent
  requireApprovalFor: "all_payments";   // v1 only option
  approverRoles: string[];
  monthlyCapMXN?: number;
}
```

### Run lifecycle

```
queued → running → awaiting_approval ──approve──→ executing → succeeded
                 │                  └──reject───→ rejected
                 └─(error / no bill)→ failed
any non-terminal ──add-in off / cancel──→ cancelled
```

- Amount changes between lookup and execution → back to `awaiting_approval` with a new approval.
- `executing` that times out → only mark `failed` once the connector confirms no charge; otherwise reconcile.
- Every transition writes an audit event and emits a webhook.

## 5. How payments happen (connector modes)

As far as we know, CFE, SACMEX and the CDMX Tesorería don't offer public payment APIs for third parties, so the agent never depends on one route.

| Mode | How it works | When |
|---|---|---|
| `mock` | Deterministic fake bills, receipts and failures | Dev, tests, console demo |
| `assisted` | Agent gets the bill and payment reference / línea de captura; the owner pays by SPEI or bank; agent takes the receipt (PDF/photo), extracts folio + amount with Claude, reconciles | First real route. No money passes through Hardwood |
| `handoff` | Agent creates a "human task" and emits `task.handoff_requested`; whoever the host assigns (e.g. a gestor) completes it and posts the receipt back | Fallback for anything automation can't do |
| `aggregator` | A licensed bill-payment provider charges the owner's payment method | True one-click. Only after decision #2 below and a legal/financial review |

Don't build browser automation against official portals in v1 (fragile, credentials, terms of service).

Predial note: a property in Alcaldía Miguel Hidalgo pays predial to the CDMX government (Tesorería), not to the alcaldía. Use the biller id `predial-cdmx`. Confirm details before building a real connector.

## 6. Data model (apps/api, Prisma)

- **Host** — an app that connects to Hardwood (console, later Gestio, Orb). Has API keys.
- **Workspace** — a customer inside a host. `hostId`, `externalRef` (the host's tenant id), `name`.
- **ApiKey** — hashed key, scoped to a host, optional workspace, scopes.
- **AgentInstallation** — `workspaceId`, `agentId`, `enabled`, `settings`, `policy`. Unique per workspace + agent.
- **AgentKillSwitch** — global per `agentId`.
- **UtilityAccount** — `workspaceId`, `propertyRef` (host's property id), `propertyLabel`, `billerId`, `accountRef`, `active`.
- **Bill** — `accountId`, `period`, `amount`, `currency`, `dueDate`, `paymentReference?`, `status` (`open` | `paid` | `overdue` | `disputed`), `source`.
- **Run** — `workspaceId`, `agentId`, `action`, `input`, `state`, `idempotencyKey @unique`, `requestedBy` (`user` | `agent` | `schedule` | `host`), `error?`.
- **RunStep** — `runId`, `at`, `kind`, `message` (human-readable), `data`.
- **Approval** — `runId`, `status`, `requestedAt`, `decidedAt`, `decidedBy` (opaque user ref from the host), `comment`.
- **Payment** — `runId @unique`, `folio`, `amount`, `paidAt`, `receiptUrl`, `mode`.
- **HandoffTask** — `runId`, `status`, `assigneeRef?`, `instructions`, `result`.
- **AuditEvent** — append-only, `prevHash`, `hash`, actor, entity, payload.
- **WebhookEndpoint / WebhookDelivery** — per host, HMAC-signed, retries with backoff, delivery log.

## 7. API v1 (apps/api)

All routes scoped by API key → host → workspace. JSON, zod-validated, `Idempotency-Key` on POSTs.

```
GET    /v1/agents                                  catalog (manifests)
GET    /v1/workspaces/:ws/agents                   installed + enabled state
PUT    /v1/workspaces/:ws/agents/:agentId          enable/disable, settings, policy

POST   /v1/workspaces/:ws/accounts                 add utility account
GET    /v1/workspaces/:ws/accounts?propertyRef=
POST   /v1/workspaces/:ws/accounts/:id/lookup      fetch current bill (creates a run)
GET    /v1/workspaces/:ws/bills?status=open

POST   /v1/workspaces/:ws/runs                     { agentId, action: "pay_bill", input: { billId } }
GET    /v1/workspaces/:ws/runs/:id                 state + steps
POST   /v1/workspaces/:ws/runs/:id/approve         { decidedBy, comment? }
POST   /v1/workspaces/:ws/runs/:id/reject
POST   /v1/workspaces/:ws/runs/:id/cancel
POST   /v1/workspaces/:ws/runs/:id/receipt         assisted mode: upload receipt

POST   /v1/workspaces/:ws/assist                   plain-language request → proposed run(s) (Phase 6)
```

Webhooks: `run.awaiting_approval`, `run.succeeded`, `run.failed`, `run.cancelled`, `bill.found`, `bill.due_soon`, `task.handoff_requested`.

Jobs: daily bill lookup per enabled account, due-soon reminders, payment execution, webhook delivery retries.

## 8. Phases

Stop after each phase for review. Don't start the next one unasked.

| # | Phase | Done when |
|---|---|---|
| 0 | **Scaffold** — monorepo, TS strict, lint/format, vitest, Docker Postgres, GitHub Actions CI, `CLAUDE.md`, ADR-001 (host-agnostic service) | `pnpm i && pnpm test && pnpm lint` pass in CI on an empty skeleton |
| 1 | **agents-core** — types, run state machine, policy engine, idempotency, audit hash chain, in-memory host for tests | Every transition tested; same idempotency key twice → one execution; disabled add-in → run cancelled; amount change → re-approval |
| 2 | **Utilities Agent + mock connector** — manifest, three billers, account-ref validation, lookup/pay flows; mock connector with scripted success, failure, timeout and amount-changed cases | Full pay flow passes against mock in tests, no DB |
| 3 | **API service** — Prisma schema, routes, API keys, jobs, signed webhooks, seed with a demo host + workspace + three mock accounts | Pay flow works end to end over HTTP with curl; webhook receiver test gets signed events |
| 4 | **Console** — add-ins page with on/off, accounts by property, open bills, run view with live step log and Approve/Reject, receipts, audit view; mock portal panel clearly labeled "Simulation" | You can demo: enable agent → pay CFE bill → approve → receipt, and turning it off hides everything |
| 5 | **Real route: assisted + handoff** — payment reference capture, receipt upload, Claude receipt extraction + reconciliation, handoff tasks | A real bill can be settled with no money passing through Hardwood |
| 6 | **LLM layer** — `/assist` endpoint and MCP server exposing `list_bills`, `request_payment`, `get_run`; model can only create runs that wait for approval | "Pay the electricity at Torre Demo" creates an approval request; tools vanish when the add-in is off |
| 7 | **Hardening** — rate limits, secret encryption, structured logs, metrics, backups, kill switch UI, threat model doc | Reviewed checklist in `docs/` |
| 8 | **Host integration (later, out of scope now)** — `client-sdk`, embeddable approval component, Gestio as first host | Separate plan when we get there |

Phase 4's console is also the quick demo. If a demo is needed before Phase 3 is done, build the console against `agents-core` + mock connector in-process first and swap to the API later.

## 9. Testing

- vitest across packages; core aims for full branch coverage of the state machine and policy engine.
- Contract tests for every connector mode against a shared suite (lookup, pay, timeout, amount changed, duplicate key).
- API integration tests against a real Postgres in Docker / CI.
- Playwright for the console happy path once Phase 4 exists.

## 10. Open decisions (ask Jandro)

1. **Service or library?** Plan assumes Hardwood Agents runs as its own service that hosts call over an API. Alternative: ship only packages that hosts embed. (Recommended: service + packages; the service is what makes it reusable across Gestio, Orb and future hosts.)
2. **Real payment route** — `assisted` first (recommended), an aggregator provider (which one, fees, coverage of CFE / SACMEX / Tesorería CDMX), or both. Moving client money needs a legal/financial review first.
3. **Approvers** — who can approve, and does approval happen in Hardwood's console, in the host's UI, or both?
4. **Hosting** — where the API and DB run (Vercel + Neon/Supabase, Fly, Railway, AWS…).
5. **Console language** — English UI (with legal/biller names in Spanish), or Spanish.
6. **Next agents** — which comes after utilities (compliance, scraper, operations from the Orb prototype).

## 11. Don'ts

- Don't import, copy or mirror Gestio code or models. Gestio integration gets its own plan.
- Don't let the model call any execute/pay function.
- Don't store or log portal passwords, card numbers or CLABEs.
- Don't build mock portals that copy CFE, SACMEX or CDMX branding.
- Don't commit to `main`; one branch per phase.
