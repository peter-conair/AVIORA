# 00 — Architecture Assessment

> **Project:** AVIORA — Multi-Tenant Membership, Healthy Living & Growth Operating System
> **Date:** 2026-08-19 · **Status:** Accepted baseline for all subsequent docs
> **Source:** `MASTER AI CODING PROMPT.md` (the "spec"). This document is the honest engineering assessment the spec asks for in FINAL INSTRUCTION item 1 — not a restatement of it.

---

## 1. Overall verdict

The spec is unusually good for a founder-authored document: it already contains the three decisions that most greenfield SaaS teams get wrong (modular monolith first, shared-schema multi-tenancy first, User ≠ Member). It also contains the single most important domain insight of the whole product — **Team Graph ≠ Referral Graph ≠ Compensation Graph** (§17–18) — which, if violated early, is nearly impossible to untangle later.

The main risks are not architectural; they are **scope and configurability risks**. The spec describes roughly 12 products (LMS, CRM, community, commerce, compensation engine, gamification, automation engine, knowledge graph, AI OS…). The MVP list (§71) is sane, but the gravitational pull of the full spec will constantly tempt the team to widen the MVP. This assessment's job is to lock the narrow path.

**Recommended approach in one sentence:** a pnpm/Turborepo monorepo with a NestJS 11 modular monolith (12 MVP modules), Next.js 15 web app, PostgreSQL 17 + Prisma with shared schema + RLS + app-level tenant injection (defense in depth), closure-table team hierarchy, transactional-outbox domain events over BullMQ, and a thin provider-agnostic AI gateway shipping only a Basic AI Assistant in MVP.

---

## 2. Strengths of the spec

1. **Modular monolith mandated (§64, §78.13).** Correct for a team of this size and a product this uncertain. Microservices here would multiply every tenant-isolation and permission problem by the number of services.
2. **User/Member separation (§7).** `User` (global identity) ↔ `TenantMembership` ↔ `Tenant`, with `Member` as per-tenant participation. This is the correct identity model for multi-tenant SaaS and is expensive to retrofit. The spec gets it right on day 1.
3. **Graph separation (§17–18).** Operational team structure, referral lineage, and compensation lineage as independent graphs is what distinguishes a platform from an MLM app. It also de-risks the legal/compliance surface: compensation can remain unbuilt (Phase 3) without blocking team features.
4. **Entitlements over plan names (§9).** Capability keys (`course.access`, `team.create`) decoupled from plan marketing names avoids the classic "if plan == 'VIP'" rot.
5. **Configurability-first (§2.11–13, §78.12).** Lifecycle stages, growth stages, CRM pipelines, onboarding, and compensation are all tenant-configured. This is stated consistently, not as an afterthought.
6. **Authorization-before-retrieval RAG (§50).** "Never retrieve unauthorized content and filter afterward" is the correct — and rarely stated — security posture for multi-tenant AI.
7. **Phasing discipline (§70–77, §83).** Explicit "do not build" lists and vertical slices. The spec even orders the coding process correctly (docs → domain model → schema → tenant/identity → …).
8. **Health-data privacy called out (§59).** Separate `health.*` permissions and default non-exposure to team leaders. This is a real regulatory concern (PDPA in Thailand; the initial market) and it is cheaper to model now.

---

## 3. Risks and how we mitigate them

| #   | Risk                                                                                                                                             | Severity | Mitigation                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Scope explosion.** The spec describes ~12 sub-products. Even the "MVP" list has 16 modules.                                                    | High     | Treat §71 as a _ceiling_, not a floor. MVP modules are frozen at: identity, tenant, membership, team, goal, learning, crm, notification, analytics, ai, audit, platform. Anything else needs an ADR.                                                                       |
| R2  | **Configurability as premature abstraction.** "Every business rule must be configurable" taken literally yields a meta-platform nobody can ship. | High     | MVP configurability = _data-driven enums + JSONB settings_, not rule engines. E.g., lifecycle stages are rows in a table, not a workflow DSL. Real rule engines (compensation §42–43, automation §51) are Phase 3.                                                         |
| R3  | **Tenant-isolation bugs.** One missed `tenant_id` filter = catastrophic data leak; the spec's own highest-priority test (§69).                   | Critical | Two independent layers: Postgres RLS keyed on `app.tenant_id` session variable **and** a Prisma client extension that auto-injects `tenant_id` into every query. Either layer alone catches the other's bugs. Automated cross-tenant tests in CI. See §5 below and doc 03. |
| R4  | **Deep-hierarchy performance.** "Hundreds of thousands of members and deeply nested teams" with per-request rollups will not work naively.       | Medium   | Closure table makes descendant _queries_ O(1) joins, but **metric rollups are precomputed asynchronously** (event-driven aggregates), never computed synchronously per dashboard request. See doc 05.                                                                      |
| R5  | **AI cost and safety.** Health-adjacent AI content with no diagnosis/medical-claims guardrails is a liability; unmetered AI is a cost bomb.      | Medium   | AI Gateway meters every call (`AIUsage` with token/cost columns), enforces per-tenant quotas, and injects a non-overridable health-safety system prompt. MVP ships one Basic Assistant only. See doc 12.                                                                   |
| R6  | **Event sprawl / lost events.** In-process event emitters lose events on crash; ad-hoc pub/sub becomes untestable.                               | Medium   | Transactional outbox (`domain_events` table written in the same TX as the state change) + BullMQ dispatch + idempotent handlers. One pattern, everywhere. See doc 11.                                                                                                      |
| R7  | **Compensation/legal exposure.** Direct-selling compensation engines carry regulatory weight (e.g., Thai Direct Sales Act).                      | Medium   | Compensation is Phase 3 and _optional per tenant_ (spec §42). Nothing in Core may import from a future compensation module. The graph separation (§17) is what makes this deferral safe.                                                                                   |
| R8  | **i18n retrofit cost.** "No hard-coded UI text" is easy to violate in week 1 and expensive to fix in month 6.                                    | Low      | next-intl with th/en message catalogs from the first commit; lint rule against literal JSX text.                                                                                                                                                                           |

---

## 4. Ambiguities in the spec and our resolutions

The spec leaves these open; we resolve them here so downstream docs are consistent.

1. **Member vs TenantMembership overlap (§7, §66).** The spec lists both. Resolution: `TenantMembership` is the _link_ row (user ↔ tenant, roles, status); `Member` is the rich per-tenant _participation profile_ (goals, teams, CRM ownership, health data). A Member always references exactly one TenantMembership. Staff-only users (e.g., a platform support agent granted tenant access) may have a TenantMembership without a Member row.
2. **"Membership" is overloaded** — it means the subscription plan relationship (§8), team membership (§13), and tenant membership (§7). Resolution: we use three distinct entity names everywhere: `Membership` (member ↔ MembershipPlan), `TeamMembership`, `TenantMembership`. Docs and code never say "membership" unqualified.
3. **Tenant resolution precedence (§6)** lists mechanisms but no order. Resolution: subdomain → custom domain → `X-Tenant-ID` header (internal/service calls) → JWT claim, with a consistency check when multiple are present (mismatch = 400). See doc 03.
4. **Closure table vs alternatives (§15)** — the spec mandates closure table but doesn't argue it. We validate the choice below (§5) rather than accept it blindly.
5. **RLS "where appropriate" (§61)** is vague. Resolution: RLS on **every tenant-owned table**, with an explicit exempt list of platform-scope tables (`tenants`, `users`, `plans`, `domain_events` consumers-side reads, platform analytics). See doc 03.
6. **Which lifecycle is canonical** — member journey (§3), growth stages (§23), CRM pipeline (§34) partially overlap. Resolution: three separate configurable stage machines: `lifecycle_stage` (person-level), `growth_stage` (business-development level), `crm_pipeline_stage` (per-lead/deal). They emit events but never share tables.
7. **Where does "health" live in MVP?** §71 excludes "Advanced Health" but §66 lists `HealthGoal`, `HealthProfile`. Resolution: MVP `goal` module supports a `category = HEALTH` goal type with the stricter `health.*` permission checks; dedicated health module (wellness score, tracking) is Phase 2.

---

## 5. Key trade-offs (decisions with reasoning)

### 5.1 Modular monolith vs microservices — **modular monolith** ✅

Not a close call. Team size, unknown product-market fit, and the fact that _every_ module needs the same TenantContext, RBAC-with-scopes, and audit plumbing argue for one deployable. What we protect instead is **extractability**: modules communicate only via domain events or exported application services (enforced by lint rules on import paths — doc 21). If a module ever needs independent scaling (most likely candidates: `ai`, `analytics`), the outbox/BullMQ seam is already the network boundary.

The trap to avoid is the _distributed monolith in one process_: modules reaching into each other's Prisma tables. Module boundary = module owns its tables; cross-module reads go through the owning module's application service.

### 5.2 Shared schema vs dedicated DB per tenant — **shared schema + RLS**, migration path preserved ✅

- Dedicated DBs at MVP = operational suicide for a small team (N migrations, N connection pools, N backup policies) for tenants that may have 20 members.
- Schema-per-tenant (same DB) is a middle ground but breaks Prisma's single-schema model and makes cross-tenant platform analytics painful.
- Shared schema with `tenant_id NOT NULL` + composite indexes leading with `tenant_id` scales comfortably to thousands of tenants.
- The migration path (spec §61) is preserved by three invariants: (a) every tenant-owned row carries `tenant_id`, (b) no cross-tenant foreign keys among tenant-owned tables, (c) uuid v7 PKs are globally unique — so a tenant's rows can be streamed out to a dedicated DB without key rewriting. Doc 03 details the extraction procedure.

### 5.3 Closure table vs `ltree` vs recursive CTE — **closure table** ✅ (validating the spec's choice)

| Criterion                 | Recursive CTE (adjacency only)    | Postgres `ltree`                       | Closure table                                       |
| ------------------------- | --------------------------------- | -------------------------------------- | --------------------------------------------------- |
| Descendants query         | O(depth) recursive scan per query | Fast (GiST index)                      | Single indexed join                                 |
| Ancestors query           | Recursive                         | Fast (prefix ops)                      | Single indexed join                                 |
| Move subtree              | Free (just reparent)              | Rewrite every descendant's path        | Delete/insert closure rows (bounded, transactional) |
| Depth-limited queries     | Awkward                           | Awkward                                | `WHERE depth <= n` — trivial                        |
| Referential integrity     | FK only                           | Path is a string — no FK to parents    | Every closure row FK-constrained                    |
| ORM friendliness (Prisma) | OK                                | Poor (custom type, raw SQL everywhere) | Excellent (plain table)                             |
| History/audit             | N/A                               | Path rewrites destroy old paths        | Closure rebuild + audit events preserve history     |

`ltree` loses on Prisma ergonomics and on referential integrity; recursive CTEs are fine for occasional queries but the leader dashboard hits descendant sets on _every_ page view. Closure table costs O(subtree × ancestors) rows on move — acceptable because team moves are rare admin operations. We keep `parent_team_id` as the source of truth and treat the closure table as a derived, transactionally-maintained index (rebuildable from adjacency if ever corrupted). Worked SQL in doc 05.

### 5.4 RLS vs app-level filtering — **both** (RLS as backstop, app-level as primary) ✅

App-level filtering alone: one forgotten `where` clause leaks data. RLS alone: easy to misconfigure (`BYPASSRLS` roles, missed `SET`), and Prisma's pooled connections require careful session-variable handling. So:

- **Primary:** Prisma client extension auto-injects `tenant_id` into reads and writes for tenant-owned models (allowlist of platform-scope models exempt).
- **Backstop:** RLS policies `USING (tenant_id = current_setting('app.tenant_id')::uuid)` on every tenant-owned table; app connects as a non-`BYPASSRLS` role; each transaction begins with `SET LOCAL app.tenant_id`.
- **Verification:** CI test suite logs in as Tenant A and attempts every endpoint against Tenant B's data — must get 404/403, never 200 and never empty-200-that-would-have-leaked.

Cost: RLS adds a per-query predicate (cheap with the tenant-leading indexes) and requires `SET LOCAL` discipline in the Prisma extension. Worth it — this is the failure mode that ends the company.

### 5.5 Outbox + BullMQ vs plain EventEmitter vs Kafka — **outbox + BullMQ** ✅

EventEmitter loses events on crash and provides no retry/DLQ. Kafka is operational overkill (we run Redis already for cache/queues). Transactional outbox gives atomicity (event persisted with the state change), BullMQ gives retry/backoff/DLQ, and the `domain_events` table doubles as an audit-grade event log and future replay source. Details in doc 11.

### 5.6 AI: build-out vs thin gateway — **thin gateway, one assistant** ✅

The spec's 11 logical agents (§48) are prompt/context configurations, not services. MVP ships one Basic AI Assistant through a provider-agnostic gateway (default provider Anthropic, model `claude-sonnet-5`). pgvector RAG is Phase 2 — MVP context assembly is deterministic (structured queries under the caller's permissions), which incidentally satisfies §50's authorization-before-retrieval by construction. Doc 12.

---

## 6. What we explicitly defer (and why deferral is safe)

| Deferred                               | Phase                 | Why safe to defer                                                                                                                                                         |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commerce/checkout/subscription billing | 2                     | No schema coupling with MVP modules; orders reference members, nothing references orders.                                                                                 |
| Compensation, rank, reward engines     | 3                     | Graph separation (§17) means team features never read compensation lineage.                                                                                               |
| Referral graph _processing_            | 3                     | We **do** create the `referral_relationships` table in MVP (capturing who-referred-whom at registration is cheap and unrecoverable if missed) — but build no logic on it. |
| Automation workflow engine             | 3                     | MVP hard-codes the ~5 automations that matter (welcome flows, expiry reminders) as event handlers; the trigger-action DSL comes later.                                    |
| pgvector RAG, embeddings               | 2                     | Basic assistant works on structured context; schema reserves nothing that blocks adding `embeddings` tables later.                                                        |
| Community feed/posts                   | 2                     | Isolated module; teams get communities via event handler when built.                                                                                                      |
| OAuth2/OIDC federation, MFA            | 2                     | MVP: email+password (Argon2id), JWT 15-min access + rotating refresh in HttpOnly cookies. Auth module interface designed so OIDC slots in as an additional strategy.      |
| Dedicated DB per large tenant          | 4                     | Invariants in §5.2 keep the door open.                                                                                                                                    |
| Native mobile app                      | 4                     | PWA (spec §63) covers mobile-first for MVP.                                                                                                                               |
| Microservices extraction               | Never, until measured | Spec's own rule (§FINAL): "Do not introduce microservices until there is a measurable scaling reason."                                                                    |

---

## 7. Recommended approach — summary of canonical decisions

These are binding on all other docs and on implementation:

- **Repo:** pnpm workspaces + Turborepo. `apps/web` (Next.js 15 App Router, TS, Tailwind, PWA, next-intl th/en), `apps/api` (NestJS 11), `packages/db` (Prisma), `packages/shared`, `packages/config`, `docs/`, `scripts/`. (Doc 21.)
- **DB:** PostgreSQL 17 + Prisma. snake_case tables/columns via `@map`/`@@map`, uuid v7 PKs, all timestamps `timestamptz` (`@db.Timestamptz(6)`). Every tenant-owned table: `tenant_id NOT NULL` + composite indexes leading with `tenant_id`. RLS via `app.tenant_id` session var; platform-scope tables exempt.
- **Tenant context:** `nestjs-cls` (AsyncLocalStorage). All domain services receive TenantContext. (Doc 03.)
- **Identity:** User ↔ TenantMembership ↔ Tenant; Member = per-tenant participation. JWT access 15 min + refresh rotation, HttpOnly cookies, Argon2id. OAuth2/OIDC + MFA Phase 2.
- **RBAC scopes:** `SELF`, `DIRECT_TEAM`, `DESCENDANT_TEAMS`, `SPECIFIC_TEAMS`, `TENANT_ALL`. Permission keys in dot-notation.
- **Events:** outbox `domain_events` + BullMQ. Event names PascalCase. (Doc 11.)
- **MVP NestJS modules (frozen):** `identity`, `tenant`, `membership`, `team`, `goal`, `learning`, `crm`, `notification`, `analytics`, `ai`, `audit`, `platform`.
- **Cache:** Redis, keys prefixed `tenant:{id}:`. **Storage:** Cloudflare R2, paths `/tenants/{tenant_id}/...`.
- **Observability:** pino structured logs carrying `request_id`, `tenant_id`, `user_id`; Sentry; OpenTelemetry-ready.
- **API:** REST `/api/v1`, cursor pagination, error envelope `{ "error": { "code", "message", "details", "request_id" } }`.
- **i18n:** th + en from day 1.

---

## 8. Open questions for the product owner

Non-blocking for Sprint 0, but need answers before the features land:

1. **Billing the tenants themselves** (platform-level subscription for `subscription_plan_id`): Stripe? Manual invoicing for early tenants? Affects `platform` module scope.
2. **LINE as a notification channel** (§52) — is LINE OA sign-up expected per tenant, or one platform OA? Affects notification module design in Phase 2.
3. **PDPA compliance posture**: is a DPO/consent-record requirement in scope for MVP, or is the first tenant operating under a single legal entity? Health data (§59) raises the bar.
4. **First tenant's dataset** (§31 "first brand as initial dataset") — which brand, and is its product data licensed for platform use?
5. **Custom domains at MVP** — the resolution chain supports them, but do we need automated TLS issuance (Cloudflare for SaaS) in MVP or is `*.platform.com` enough for the first tenants?
