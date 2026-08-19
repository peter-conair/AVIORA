# 20 — Architecture Decision Records

> **AVIORA** — the log of decisions that shape the system. Dev rule 20: _document all architectural decisions._
>
> Status: Living document · Last updated: 2026-08-19 · Format: Status / Context / Decision / Consequences / Alternatives

New ADRs are appended with the next number. An ADR is never edited into a different decision — supersede it with a new ADR and mark the old one `Superseded by ADR-0NN`.

| #   | Title                                                | Status   |
| --- | ---------------------------------------------------- | -------- |
| 001 | Modular monolith over microservices                  | Accepted |
| 002 | Shared DB / shared schema + tenant_id + Postgres RLS | Accepted |
| 003 | Closure table for team hierarchy                     | Accepted |
| 004 | User/Member separation with TenantMembership         | Accepted |
| 005 | Entitlement-based capability model                   | Accepted |
| 006 | Separate Team / Referral / Compensation graphs       | Accepted |
| 007 | Transactional outbox + BullMQ for domain events      | Accepted |
| 008 | Prisma as ORM                                        | Accepted |
| 009 | Provider-agnostic AI Gateway                         | Accepted |
| 010 | REST before GraphQL                                  | Accepted |
| 011 | pnpm + Turborepo monorepo                            | Accepted |
| 012 | UUID v7 keys + timestamptz everywhere                | Accepted |
| 013 | JWT in HttpOnly cookies                              | Accepted |

---

## ADR-001 — Modular Monolith over Microservices

**Status:** Accepted (2026-08-19)

**Context:** AVIORA spans ~18 domains (identity, tenant, membership, team, goal, learning, crm, community, commerce, compensation, ai, …). A solo developer with AI assistance must ship an MVP in months. The spec (§64, §78 rule 13, FINAL INSTRUCTION) explicitly warns against premature microservices, while requiring that modules be extractable later.

**Decision:** Build a single NestJS 11 application (`apps/api`) organized as a modular monolith. Each domain is a NestJS module with its own controllers, services, and repository layer. Modules communicate through domain events (ADR-007) and explicit service interfaces — never by reaching into another module's tables or internals. One deployable image runs in two modes: HTTP server and BullMQ worker.

**Consequences:**

- One deploy, one database transaction boundary, one debugging surface — maximum velocity for a solo dev.
- Module boundaries + event-driven communication keep extraction into services possible when a measurable scaling reason appears (spec's condition for microservices).
- Discipline required: cross-module imports are limited to published module APIs; enforced by ESLint boundary rules.
- Whole app scales as a unit initially; worker process (ADR-007) is the first independently scalable seam.

**Alternatives considered:**

- _Microservices from day 1_ — rejected: operational overhead (service discovery, distributed transactions, N pipelines) fatal for a solo dev; explicitly forbidden by spec.
- _Single unstructured monolith_ — rejected: without enforced module boundaries the Phase 4 extraction path disappears.
- _Serverless functions_ — rejected: long-lived queue consumers, RLS session state, and Prisma connection pooling fit containers better.

---

## ADR-002 — Shared Database / Shared Schema + tenant_id + Postgres RLS

**Status:** Accepted (2026-08-19)

**Context:** Tenant isolation is the platform's cardinal rule (spec §4, §69). Spec §61 prescribes shared DB/shared schema with `tenant_id` and RLS for MVP, with a future dedicated-DB option for large tenants. Application-level `WHERE tenant_id = ?` filters alone are one forgotten clause away from a breach.

**Decision:** One PostgreSQL 17 database, one schema. Every tenant-owned table carries `tenant_id uuid NOT NULL`. Row-Level Security is enabled and **forced** on all such tables with policies bound to the session setting `app.tenant_id`; the application connects as a non-owner role so RLS actually applies. TenantContext middleware resolves the tenant per request and sets `app.tenant_id` on the connection for the request's duration. Platform-global tables (users, tenants themselves, global knowledge) are explicitly catalogued as RLS-exempt. The architecture reserves a migration path: a large tenant's rows can be extracted to a dedicated database later because every row is tenant-keyed and the app resolves connections through a single database-routing seam.

**Consequences:**

- Defense in depth: even a buggy query cannot cross tenants — the database refuses.
- Cheapest possible operations for hundreds of small tenants (one DB, one backup, one migration run).
- Testing must use the non-owner role (RLS is invisible to owners) — encoded in the test strategy.
- All connections pass through the context-setting seam; raw SQL and background jobs must establish tenant context explicitly (worker jobs carry `tenant_id` in their payload).
- Noisy-neighbor risk at large scale → mitigated by the reserved dedicated-DB path (Phase 4).

**Alternatives considered:**

- _Schema-per-tenant_ — rejected: migrations × N schemas, Prisma fits poorly, painful at hundreds of tenants.
- _Database-per-tenant from day 1_ — rejected: operational cost and connection-pool explosion for an MVP with small tenants; kept as the Phase 4 enterprise option.
- _Application-level filtering only_ — rejected: a single missed `where` clause is a cross-tenant breach; unacceptable given the spec's highest-priority test.

---

## ADR-003 — Closure Table for Team Hierarchy

**Status:** Accepted (2026-08-19)

**Context:** Teams nest to unlimited, non-hard-coded depth (spec §11, dev rule 4). Required queries: ancestors, descendants, depth, subtree metrics rollup (direct vs organization), and team move — all tenant-scoped and permission-scoped (`DESCENDANT_TEAMS`). Spec §15 prescribes `parent_team_id` + closure table.

**Decision:** Store `parent_team_id` on `teams` as the adjacency source of truth, plus a `team_closure` table (`tenant_id, ancestor_team_id, descendant_team_id, depth`) maintained transactionally by the team module on create/move/archive. All hierarchy reads (descendant lists, rollups, scope checks) go through the closure table.

**Consequences:**

- Descendant/ancestor queries are single indexed joins — fast enough for deep trees and dashboard rollups.
- Write cost on team move (delete + reinsert subtree closure rows) is acceptable: moves are rare, reads are constant.
- Closure maintenance is a correctness hot spot → dedicated invariant test suite (test strategy §8).
- Closure rows are plain rows, so RLS applies uniformly (unlike some extension-based options).

**Alternatives considered:**

- _Recursive CTEs only_ — rejected: correct but repeatedly pays traversal cost on every scope check and rollup; permission middleware would run CTEs on nearly every request.
- _Postgres `ltree`_ — rejected: path-encoded keys make team moves rewrite every descendant's path, extension support varies across managed providers, and Prisma has no native mapping.
- _Nested sets_ — rejected: writes require renumbering large ranges; concurrency-hostile.

---

## ADR-004 — User/Member Separation with TenantMembership

**Status:** Accepted (2026-08-19)

**Context:** Spec §7 mandates: a User is a global authentication identity; a Member is a person's participation inside one tenant; one person may be Member in Tenant A, Coach in Tenant B, Admin in Tenant C.

**Decision:** Three entities: `User` (global, credentials, no tenant_id), `TenantMembership` (user_id + tenant_id + status — the bridge that authorizes a user's presence in a tenant), and `Member` (tenant-owned Member 360 record: profile, goals, teams, learning, CRM book). Authentication yields a User; selecting a tenant (subdomain, custom domain, or switcher) resolves the TenantMembership and loads the Member context. Roles and entitlements attach within the tenant context, never globally.

**Consequences:**

- One login, many tenants — the tenant switcher is a first-class UI feature.
- No PII duplication across tenants for the same person, while each tenant's member data stays isolated under RLS.
- Every authorization check requires resolved tenant context — enforced structurally by TenantContext middleware.
- Slightly more complex onboarding flow (invite → user exists? → attach membership : register) — covered by lifecycle tests.

**Alternatives considered:**

- _User == Member (tenant_id on users)_ — rejected: forces duplicate accounts per tenant, breaks the multi-tenant persona requirement.
- _Global member with tenant array_ — rejected: smears tenant-owned data across the isolation boundary; RLS cannot protect intra-row structures.

---

## ADR-005 — Entitlement-Based Capability Model

**Status:** Accepted (2026-08-19)

**Context:** Spec §9: never hard-code functionality into membership names. Plans are tenant-configurable (§8); code branching on "Premium" breaks the moment a tenant renames or invents a plan.

**Decision:** Introduce `Entitlement` as the capability currency (e.g. `course.access`, `ai.coach`, `team.create`, `ai.quota.daily`). Membership plans map to sets of entitlements; a member's active membership resolves to an entitlement set; all capability checks in code ask `hasEntitlement(ctx, 'x.y')` — never `plan.name === ...`. Entitlements compose with RBAC: roles govern _what you may do_, entitlements govern _what your membership includes_; a sensitive action may require both.

**Consequences:**

- Tenants create arbitrary plans with arbitrary names — zero code change (dev rules 6, 12).
- Quota-style entitlements (AI daily cap, storage) carry values, not just booleans.
- Entitlement resolution is on the hot path → cached per member with invalidation on membership change (cache flush discipline in deploy pipeline).
- A catalogued entitlement registry is needed so plans configure against known capabilities; new features must register their entitlements.

**Alternatives considered:**

- _Logic on plan names/tiers_ — rejected: hard-codes membership structure, violates dev rule 6.
- _Feature flags only_ — rejected: flags are tenant/deployment-level toggles, not per-member commercial capabilities; both exist but serve different purposes.

---

## ADR-006 — Separate Team / Referral / Compensation Graphs

**Status:** Accepted (2026-08-19)

**Context:** Spec §17 is mandatory: the operational team tree is NOT the referral tree, and the referral tree is NOT the compensation tree. Member A may recruit Member B, yet B may operate under a different team leader. Dev rules 8–9 forbid coupling.

**Decision:** Model each relationship as its own graph with its own tables: `team_membership`/`team_closure` (operational structure), `referral_relationship` (who introduced whom, with relationship_type and effective dates), and — in Phase 3 — compensation-graph tables owned by the compensation module. No foreign keys, joins-for-logic, or derivations between the graphs; any correlation (e.g. "how many recruits are also in my team") is computed read-side in analytics, never enforced structurally.

**Consequences:**

- A member's team placement can change without touching referral history; compensation plans can define their own placement logic independently.
- Historical integrity per graph via effective dates (dev rule 15).
- Three graphs mean three sets of queries and tests — the cost of the spec's core structural requirement.
- Coupling regressions are caught by dedicated tests (Phase 3 exit criteria).

**Alternatives considered:**

- _One tree with typed edges_ — rejected: one member's edges differ per concern; a single tree cannot represent divergent structures without exactly the coupling the spec forbids.
- _Derive compensation from referral_ — rejected: locks the platform to one class of comp plans, violating configurability (dev rule 7).

---

## ADR-007 — Transactional Outbox + BullMQ for Domain Events

**Status:** Accepted (2026-08-19)

**Context:** Spec §64–§65 requires domain events (TenantCreated, MemberRegistered, RankAchieved, …) driving notifications, automations, and analytics. Publishing to a queue directly inside a request risks the classic dual-write problem: DB commit succeeds but publish fails (or vice versa).

**Decision:** Domain mutations write their events to a `domain_events` outbox table **in the same database transaction** as the state change (event_id uuid v7, tenant_id, type, payload jsonb, occurred_at, processed_at). A relay in the worker process polls unprocessed events and enqueues them to BullMQ (Redis) topics; consumers (notification, automation, analytics, AI jobs) handle them idempotently keyed on event_id. Failed jobs retry with exponential backoff; a dead-letter queue is monitored.

**Consequences:**

- Exactly-once _recording_ of events with the business fact; at-least-once _delivery_ — consumers must be idempotent (enforced in code review + tests).
- The outbox doubles as an audit-grade event history and a replay source (commission runs reproducible from events — Phase 3 exit criterion).
- Polling adds small latency (~1–2 s) — acceptable for notifications/automations.
- Redis/BullMQ is already in the stack (cache), so no new infrastructure.

**Alternatives considered:**

- _Direct BullMQ publish in-request_ — rejected: dual-write inconsistency.
- _Postgres LISTEN/NOTIFY_ — rejected: no durability or replay; lost on disconnect.
- _Kafka/NATS_ — rejected: heavyweight for MVP scale; violates "optimize for simplicity before scale" (dev rule 19). Revisit if extraction to services happens.

---

## ADR-008 — Prisma as ORM

**Status:** Accepted (2026-08-19)

**Context:** Spec §63 recommends PostgreSQL + Prisma. The team is one senior TypeScript developer with AI assistance; schema evolves fast during MVP; type safety across a monorepo matters.

**Decision:** Prisma is the ORM in `packages/db`: schema.prisma is the source of truth (snake_case mapped names, uuid v7 defaults via app-side generation, `@db.Timestamptz`), `prisma migrate` for migrations (deployed via `migrate deploy` on boot), generated client shared by api and worker. RLS interplay: the app role is non-owner; tenant context is set per request via `SET LOCAL app.tenant_id` through a Prisma client extension wrapping queries in the context-bearing transaction. Closure-table maintenance and other hot SQL use `$queryRaw` with parameterized queries where the query builder falls short.

**Consequences:**

- End-to-end type safety from schema to API DTOs; fast iteration with AI codegen.
- Migration discipline comes built-in (checksummed history, `migrate deploy` non-interactive).
- RLS + connection pooling requires the transaction-scoped `SET LOCAL` pattern — a known, tested seam (Sprint 0 spike).
- Some hierarchy/rollup SQL is hand-written; RLS still protects it.

**Alternatives considered:**

- _TypeORM_ — rejected: weaker migration story and type inference; decorator entity model duplicates schema knowledge.
- _Drizzle_ — strong candidate (SQL-first, lighter), but Prisma's maturity, migration tooling, and spec recommendation win for MVP.
- _Raw SQL/knex_ — rejected: too slow to iterate for one developer across ~50 entities.

---

## ADR-009 — Provider-Agnostic AI Gateway

**Status:** Accepted (2026-08-19)

**Context:** Spec §46: do not couple domain code to a model provider (OpenAI, Anthropic, Gemini, future). AI must receive full tenant/user/member/team/permission context (§47), enforce authorization before retrieval (§50), and be cost-capped per tenant (deployment doc §7).

**Decision:** All AI calls flow through an internal AI Gateway module: `Application → AI Gateway → Model Router → Provider adapter`. The gateway (a) assembles the authorized context (tenant, member, scope, entitlements), (b) performs permission-filtered retrieval _before_ any provider call, (c) routes to a provider/model by task profile and tenant config, (d) meters usage into `ai_usage` (tenant_id, tokens, cost) and enforces daily quotas, (e) normalizes responses and errors. Provider adapters implement one interface; tests run against a fake adapter.

**Consequences:**

- Swapping or mixing providers is config, not refactor; per-tenant model preferences become possible.
- Central choke point makes AI permission tests, quota caps, and cost attribution tractable (they'd be impossible with scattered SDK calls).
- Slight abstraction tax (lowest-common-denominator features); provider-specific capabilities are exposed behind capability flags on the adapter interface.
- Domain modules never import a provider SDK — enforced by ESLint boundaries.

**Alternatives considered:**

- _Direct SDK calls per feature_ — rejected: couples domains to providers, scatters cost/permission enforcement.
- _External hosted gateway (e.g. LLM proxy SaaS)_ — rejected for MVP: tenant data would transit a third party; revisit for scale with a self-hosted proxy behind the same internal interface.

---

## ADR-010 — REST before GraphQL

**Status:** Accepted (2026-08-19)

**Context:** Spec §67 prescribes REST at `/api/v1` with every call resolving tenant, user, permission, scope. One developer, one first-party web client, heavy emphasis on per-endpoint authorization testing (isolation suite iterates a route registry).

**Decision:** REST (`/api/v1/...`) with NestJS controllers, consistent envelope/pagination conventions, and OpenAPI generated from decorators as the contract. GraphQL is deferred until there is a concrete consumer need (e.g. Phase 4 API marketplace or mobile clients with divergent data shapes).

**Consequences:**

- Per-route guards map 1:1 to the permission model; the isolation suite can enumerate endpoints mechanically.
- Cloudflare caching/rate-limiting rules are simple per-path.
- Some over/under-fetching on dashboard screens → mitigated with purpose-built read endpoints (`/teams/:id/dashboard`).
- A later GraphQL layer can be added as a facade over the same services without rework.

**Alternatives considered:**

- _GraphQL first_ — rejected: field-level authorization across tenant + scope + entitlements is far harder to prove exhaustively; N+1 and cost-limiting complexity for zero current consumers.
- _tRPC_ — rejected: excellent DX but couples contract to TS clients; REST keeps Phase 4 public-API options open.

---

## ADR-011 — pnpm + Turborepo Monorepo

**Status:** Accepted (2026-08-19)

**Context:** Frontend (Next.js 15), backend (NestJS 11), shared Prisma schema, shared types/validation, shared config — one developer needs atomic cross-stack changes and one CI pipeline.

**Decision:** A pnpm workspace managed by Turborepo:

```text
apps/web        Next.js 15 · TypeScript · Tailwind · PWA · next-intl (th/en)
apps/api        NestJS 11 (HTTP server + worker entrypoint)
packages/db     Prisma schema, client, migrations, seed, fixtures
packages/shared domain types, DTO/zod schemas, constants (entitlement/permission catalogs)
packages/config shared tsconfig, ESLint, Tailwind presets
```

Turborepo orchestrates `build/lint/typecheck/test` with caching; pnpm gives strict, deduplicated node_modules.

**Consequences:**

- One PR changes schema + API + UI + tests atomically; types flow from `packages/db`/`shared` into both apps.
- CI is fast via Turbo remote/local caching; unaffected packages skip work.
- Docker builds use pnpm-aware multi-stage builds (`pnpm deploy` per app).
- Boundary discipline (who may import what) enforced via ESLint + package exports.

**Alternatives considered:**

- _Polyrepo_ — rejected: cross-repo schema/type drift and multi-PR changes are poison for a solo dev.
- _Nx_ — capable but heavier; Turborepo's simpler task-graph model suffices.
- _npm/yarn workspaces alone_ — rejected: no task orchestration or caching.

---

## ADR-012 — UUID v7 Keys + timestamptz Everywhere

**Status:** Accepted (2026-08-19)

**Context:** Keys must be globally unique across tenants (future dedicated-DB extraction, ADR-002, must not collide), non-enumerable (public URLs), and index-friendly. Naive `timestamp without time zone` columns are a proven source of silent 7-hour bugs (documented in the org's timezone-standard audit).

**Decision:** All primary keys are **UUID v7** (time-ordered), generated app-side in `packages/db`. All event/temporal columns are **`timestamptz`** (Prisma `@db.Timestamptz`); the entire stack runs `TZ=UTC`; values cross the API as ISO-8601 with offset; conversion to tenant/user timezone happens only at the presentation edge. Plain `time`/`date` types are reserved for genuine wall-clock values (e.g. business hours).

**Consequences:**

- v7's time-ordering keeps B-tree inserts append-friendly (avoids v4's random-write index bloat) while staying non-enumerable.
- Tenant data extraction/merge never faces key collisions.
- One interpretation of every stored instant; DB-side `now()` and app-side dates compare safely.
- 16-byte keys are larger than bigint — an accepted cost; hot composite indexes lead with `tenant_id`.

**Alternatives considered:**

- _bigint sequences_ — rejected: enumerable, collide across databases on extraction/merge.
- _UUID v4_ — rejected: random inserts fragment indexes at scale; no ordering benefit.
- _ULID/KSUID_ — same idea, but UUID v7 is the standards-track native-uuid-compatible choice.
- _naive timestamps + convention_ — rejected: the convention always erodes; the org has the scars to prove it.

---

## ADR-013 — JWT in HttpOnly Cookies

**Status:** Accepted (2026-08-19)

**Context:** Spec §58 requires OAuth2/OIDC-compatible session security. Tokens in `localStorage` are readable by any XSS payload — a known anti-pattern (org security rules). The web app and API share a site, so cookies work naturally.

**Decision:** Authentication issues a short-lived **access JWT** (~15 min) and a rotating **refresh token**, both delivered as `HttpOnly; Secure; SameSite=Lax` cookies (refresh cookie path-scoped to the refresh endpoint). Passwords are hashed with **Argon2id**. JWT claims carry `user_id` and the active `tenant_id` context (tenant switching re-issues the access token); permissions/entitlements are resolved server-side per request, not trusted from the token. CSRF risk under SameSite=Lax is additionally mitigated with origin checks on state-changing routes. Refresh tokens are stored hashed, rotated on use, and revocable per session (device list / logout-all).

**Consequences:**

- Script-stealable tokens eliminated; XSS blast radius reduced (still defended via CSP and sanitization).
- Server-side permission resolution means a permission change takes effect within one access-token lifetime, without waiting for token expiry of stale claims.
- Mobile/native clients (Phase 4) need an Authorization-header path — the same JWTs work; only transport differs.
- Cookie domain strategy must cover tenant subdomains and custom domains (API on a first-party path per domain via Cloudflare routing).

**Alternatives considered:**

- _JWT in localStorage_ — rejected: XSS-exfiltratable; banned by org security rules.
- _Opaque server sessions (Redis)_ — solid, but JWT + refresh gives lower per-request state and a cleaner path to Phase 4 SSO/API tokens; revocation needs are met by short access-token life + rotating refresh.
- _bcrypt_ — rejected in favor of Argon2id (memory-hard, current OWASP first choice).
