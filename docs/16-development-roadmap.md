# 16 — Development Roadmap

> **AVIORA** — phased delivery roadmap from Sprint 0 to the Phase 4 enterprise platform.
>
> Status: Approved · Last updated: 2026-08-19 · Source of truth: MASTER AI CODING PROMPT (spec §70–§78, §83–§84)

---

## Delivered so far (as-built, 2026-08-20)

The roadmap below is the plan; this table is what actually exists, so the two
never drift silently.

| Sprint | Scope                                                                                                                                                                                                                                              | State       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 0      | Monorepo, compose stack, CI + gitleaks, base schema, RLS + non-owner role, TenantContext, error envelope, idempotent seed                                                                                                                          | done        |
| 1      | Vertical Slice 1 — auth, tenant provisioning, plans + entitlements, invitations, teams, goals, learning, dashboard, audit, outbox + email                                                                                                          | done        |
| 2      | Vertical Slice 2 — recursive teams, scoped permissions, subtree move, direct vs organization rollups, leader dashboard                                                                                                                             | done        |
| 3      | CRM (configurable pipeline, conversion, follow-ups), notification centre, audit viewer                                                                                                                                                             | done        |
| 4      | Vertical Slice 3 — knowledge graph, brand-neutral journey, knowledge-first search, AI Lite with quotas and citations; content i18n (th/en)                                                                                                         | done        |
| 5      | MVP hardening — route-registry isolation sweep, ESLint module boundaries, multi-tenant-user proof, Playwright at a phone viewport                                                                                                                  | done        |
| 6      | **Phase 2 begins:** Healthy Living OS — habits, metrics, 30-day summary, consent-gated health privacy, PII field encryption                                                                                                                        | done        |
| 7      | Community (team spaces, posts, comments, reactions), Challenge engine (progress derived from habits/courses/goals), Gamification (configurable point rules, badges, leaderboards)                                                                  | done        |
| 8      | Commerce OS — catalogue on top of the knowledge graph, membership pricing as data, coupons, cart with snapshotted prices, provider-agnostic payments; Subscriptions at any interval with pause/skip/resume/cancel and idempotent renewal (docs/24) | done        |
| 9      | **Phase 3 begins:** Referral graph as its own structure (spec §17 mandatory), Rank engine with qualifications as data, derived metrics, as-of reproducible evaluation (docs/25)                                                                    | done        |
| 10     | Compensation rule engine — the compensation graph (third graph), plans and rules as data, commission runs that are idempotent per period and frozen on approval (docs/26)                                                                          | done        |
| 11     | Automation OS (rules on the existing outbox, idempotent per event) + Reward OS (recognition, separate from money) — docs/27                                                                                                                        | done        |
| 12     | Analytics OS at four scopes + AI Team Coach answering from the same scoped numbers; health excluded from every shared dashboard (docs/28) — **Phase 3 complete**                                                                                   | done        |
| 13     | **Phase 4 begins:** White label (branding as data, hiding ≠ access control) + multi-country (country, currency, timezone, legal versions, one tax rate) — docs/29                                                                                  | done        |
| 14     | Public API + webhooks on the existing outbox, scoped API keys, branded PWA manifest — docs/30                                                                                                                                                      | in progress |
| 15     | Enterprise SSO (OIDC, authentication only — claims never grant) + the dedicated-database seam, extract/verify tooling and runbook (docs/31–32). **Phase 4 code complete; the migration criterion stays open until rehearsed at volume**            | done        |

Open items are tracked honestly in `14-mvp-scope.md` §3 (one row) and in the
"Known gaps" section below.

## Known gaps (carried, not forgotten)

- Notification titles/bodies are composed server-side in English; proper i18n
  needs the type + parameters stored and translated client-side.
- Products carry no translations yet — they fall back to the base language.
- The AI assistant has no team-scoped knowledge to respect yet (docs/14 §3 row 16).
- `react-hooks/set-state-in-effect` is disabled with a written reason; enabling
  it means refactoring every data-loading page.
- The outbox relay is an in-process poller; BullMQ remains the documented
  upgrade path (docs/11).
- Commerce ships no payment provider, no tax, shipping or inventory, and no
  refund flow beyond the status value. Payments are recorded, not captured;
  a PSP is another `provider` value behind the same record (docs/24 §6).
- `GET /offerings` lists active rows only, so the admin tab can create and
  price but cannot edit or archive — that needs an admin-scoped listing.
- Subscription renewal runs from an admin/scheduler endpoint; nothing calls it
  on a timer yet. Rank evaluation has the same gap.
- Compensation pays nobody: a run produces entries, and moving money is a
  payout provider — the same seam commerce payments leave open. Clawbacks and
  adjustments are not modelled, and nothing runs on a timer (docs/26 §9).

## 1. Roadmap at a Glance

```text
MVP (Phase 1)          Phase 2                Phase 3                Phase 4
─────────────          ───────                ───────                ───────
Prove the core         Deepen the journey     Growth & compensation  Enterprise & scale
Slice 1 → 2 → 3        Healthy Living,        Rank, Compensation,    Marketplace, SSO,
16 MVP modules         Knowledge Graph,       Rewards, Referral,     dedicated tenant DB,
                       Community, Commerce    AI Team Coach          white-label mobile
```

| Phase   | Theme                                                                   | Target window (solo dev + AI) |
| ------- | ----------------------------------------------------------------------- | ----------------------------- |
| MVP     | Tenant → Membership → Member → Team → Goal → Learning → CRM → Dashboard | 2026-08 → 2026-12 (~4 months) |
| Phase 2 | Healthy Living, Knowledge, Community, Commerce, AI CRM                  | 2027-Q1 → 2027-Q2             |
| Phase 3 | Rank, Compensation, Rewards, Referral, Advanced AI/Automation           | 2027-Q3 → 2027-Q4             |
| Phase 4 | Marketplace, Enterprise, White-label Mobile                             | 2028+                         |

Dates are planning targets, not commitments. Each phase gates on its exit criteria, not the calendar.

---

## 2. MVP — Phase 1 (spec §70–§74, §84)

### 2.1 Goals

Prove the architectural spine end-to-end with real, isolated tenants:

```text
Tenant → Membership → Member → Team → Goal → Learning → CRM → Dashboard
```

- Multi-tenancy with hard isolation (`tenant_id` + Postgres RLS) works in production, not just on paper.
- One User can belong to multiple tenants via `TenantMembership` (tenant switcher in UI).
- Unlimited-depth team hierarchy (closure table) with scoped leadership permissions.
- Configurable membership plans mapped to entitlements — no logic on plan names.
- A member can set goals, follow learning, and see their progress on a dashboard.
- CRM handles leads and follow-ups per member.
- AI Lite assistant that obeys tenant and team scope.
- Mobile-first, th/en, audit-logged, automated-tested.

### 2.2 Modules added (spec §71 — the 16 MVP modules)

| #   | MVP module         | NestJS module (canonical)   |
| --- | ------------------ | --------------------------- |
| 1   | Authentication     | `identity`                  |
| 2   | Tenant             | `tenant`                    |
| 3   | Tenant Switcher    | `identity` + `tenant` (web) |
| 4   | Membership         | `membership`                |
| 5   | Member Profile     | `membership`                |
| 6   | Role & Permission  | `identity`                  |
| 7   | Team Hierarchy     | `team`                      |
| 8   | Team Leadership    | `team`                      |
| 9   | Goals / Dreams     | `goal`                      |
| 10  | Learning           | `learning`                  |
| 11  | Basic CRM          | `crm`                       |
| 12  | Notifications      | `notification`              |
| 13  | Dashboard          | `analytics`                 |
| 14  | Admin              | `platform` + `tenant`       |
| 15  | Basic AI Assistant | `ai`                        |
| 16  | Audit              | `audit`                     |

Explicitly **out** of MVP (spec §71): advanced commerce, compensation, wearables, advanced health, marketplace, microservices, complex automation, native mobile app.

### 2.3 MVP delivery: three vertical slices

The MVP is delivered as three sequential vertical slices. Each slice is demoable, tested, and deployed before the next begins.

#### Vertical Slice 1 — the core loop (spec §72)

```text
Platform Admin → Create Tenant → Configure Tenant → Create Membership Plan
→ Create Tenant Admin → Tenant Admin Login → Create Team A → Assign Leader A
→ Invite Member → Member Register → Membership Activated → Member Joins Team A
→ Member Creates Goal → Member Starts Course → Member Completes Task → Dashboard Updates
```

Covers: identity, tenant, membership, team (single level), goal, learning (minimal), analytics (personal dashboard), notification (invite email), audit, platform admin.

**Slice 1 exit criteria**

- [x] **The full §72 sequence runs end-to-end through the UI** — `apps/web/e2e/vertical-slice-journey.spec.ts` walks it at a phone viewport: the tenant admin signs in, creates a team, invites a member; the member opens the invitation, registers, creates a goal, starts a course, completes a lesson, and the dashboard shows the work. Two steps stand outside the browser and say so — the tenant is provisioned over the API (the other suite proves that console renders), and the invitation token is read from the outbox because it exists nowhere a browser can reach, standing in for the email. **"On staging" remains untrue**: there is no staging environment, and nothing in this repo can create one.
- [x] Two tenants exist; the tenant-isolation test suite passes — `tenant-isolation.spec.ts`, `route-coverage.spec.ts` (drives EVERY tenant-scoped route against a foreign tenant), `multi-tenant-user.e2e.spec.ts`.
- [x] Playwright E2E covering the slice is green in CI — `apps/web/e2e/first-vertical-slice.spec.ts`, a required check ("browser E2E (mobile viewport)").
- [x] Every mutation in the flow produces an audit log row — `vertical-slice.e2e.spec.ts` asserts the eight flow actions with request ids, and `audit-coverage.spec.ts` sweeps EVERY mutating route (103 of them), requiring each to be audited or exempted with a written reason. It found four silent mutations when it was added.

#### Vertical Slice 2 — recursive teams (spec §73)

```text
Team A → Team A1 → Team A1.1 → Team A1.1.1   (different leaders at each level)
```

Covers: team closure table under depth, team move, scoped permissions (`SELF / DIRECT_TEAM / DESCENDANT_TEAMS / SPECIFIC_TEAMS / TENANT_ALL`), team dashboard with direct vs organization metrics, leadership history.

**Slice 2 exit criteria**

- [x] Parent leader sees authorized descendants; child leader cannot see unauthorized ancestors/siblings — `team-hierarchy.e2e.spec.ts`.
- [x] Metrics roll up correctly across ≥4 levels — the same suite builds A → A1 → A1.1 → A1.1.1 with different leaders and checks direct vs organization counts.
- [x] Team move preserves closure correctness and history — `PATCH /teams/:id/move` with a cycle guard, asserted in the same suite.
- [x] Tenant boundaries hold under hierarchy queries — `route-coverage.spec.ts` covers team endpoints, having found `GET /teams/:id/members` answering 200 for a foreign team.

#### Vertical Slice 3 — knowledge-to-product journey (spec §74)

```text
Healthy Living Goal → Topic → Article → Ingredient → Product
(e.g. Better Sleep → Sleep Hygiene → Educational Article → Magnesium → Related Products)
```

Covers: minimal knowledge entities (`HealthGoal`, `Topic`, `Article`, `Ingredient`, `Product`, `Brand`), their relations, knowledge-first search ordering, brand neutrality (adding Brand B requires zero schema change).

**Slice 3 exit criteria**

- [x] A member can navigate goal → topic → article → ingredient → product in the UI — browser test "the journey shows products only after the knowledge".
- [x] Search ranks knowledge/articles above products — `knowledge-ai.e2e.spec.ts`.
- [x] A second brand is seeded with no schema change — the seed ships two brands; `marketplace.e2e.spec.ts` additionally proves ordering never groups by brand (docs/44 §2).
- [x] Global vs tenant knowledge visibility enforced — `knowledge-ai.e2e.spec.ts`, and team-scoped visibility in `team-knowledge.e2e.spec.ts` (docs/37).

### 2.4 MVP exit criteria — Definition of MVP Done (spec §84)

All of the following, each backed by an automated test where feasible:

- [x] Platform Admin can create multiple tenants — `vertical-slice.e2e.spec.ts`.
- [x] Tenant data is isolated — three suites, one of which sweeps every route.
- [x] One user can belong to multiple tenants — `multi-tenant-user.e2e.spec.ts` (owner in A, member in B) + the tenant picker.
- [x] Tenant can create membership plans; entitlements gate capabilities — asserted positively and negatively (a plan without `course.access` is refused a course).
- [x] Tenant can invite members; members register and activate — the invitation flow, including the second acceptance failing.
- [x] Unlimited nested teams; members in multiple teams — `team-hierarchy.e2e.spec.ts`.
- [x] Independent leaders; leaders manage authorized descendants only — same suite, asserted in both directions.
- [x] Team hierarchy history preserved — leadership history and closure rewrite on move.
- [x] Member can create goals and follow a learning journey — Slice 1 flow.
- [x] CRM supports leads and follow-up — `crm.e2e.spec.ts`.
- [x] Dashboard shows personal and team progress — `analytics.e2e.spec.ts`, direct vs organization.
- [x] Roles and permissions work, including scope levels — `SYSTEM_ROLES` + `TeamScopeService`; a repair pass reaches tenants provisioned before a scope changed.
- [x] AI respects tenant and team permissions — `knowledge-ai.e2e.spec.ts` and `team-knowledge.e2e.spec.ts`: scope is applied IN the query, so nothing is filtered after retrieval.
- [x] Audit logs capture all sensitive actions — see Slice 1 above; the sweep is what makes this a claim rather than a hope.
- [x] Mobile UX is usable (mobile-first, th/en) — the browser suite runs at Pixel 7 and asserts no horizontal scroll; the Thai locale is exercised.
- [x] Automated tenant-isolation tests pass in CI as a required gate — "integration (RLS + tenant isolation)".

---

## 3. Phase 2 — Deepen the Journey (spec §75)

### 3.1 Goals

Turn the proven spine into the full member journey: wellness, knowledge depth, community, and commerce that _supports_ the journey.

### 3.2 Modules added

- **Healthy Living OS** — lifestyle profile, habit tracking, hydration/sleep/weight, wellness score (education-first, no diagnosis; health-data privacy permissions per spec §59).
- **Knowledge Graph** — full `HealthGoal ↔ Topic ↔ Ingredient ↔ Evidence ↔ Product` relations; global/tenant/private knowledge tiers.
- **Product Intelligence** — evidence context, safety notes, source verification, alternatives, community experience.
- **Community OS** — feed, posts, comments, reactions, groups, auto team communities.
- **Challenge Engine** — health/learning/business/team challenges.
- **Gamification OS** — XP, levels, badges, streaks, leaderboards (config-driven rules).
- **Commerce OS (basic)** — catalog, cart, checkout, membership pricing, coupons.
- **Subscription / Standing Order** — recurring engine (pause/skip/resume/cancel), program-agnostic.
- **AI Search** — RAG over knowledge with authorization-before-retrieval (spec §50).
- **AI CRM** — lead priority, next best action, follow-up generation, inactivity detection.
- **Content Recommendation** — goal/topic/ingredient-driven suggestions.

### 3.3 Exit criteria

Status as built. A checked box means a test proves it, and the proof is named.

- [x] A member can run a complete healthy-living journey (goal → habits → tracking → summary) without touching commerce — `health.e2e.spec.ts`. The summary is deliberately a summary, not a wellness _score_: see docs/13.
- [ ] Knowledge search is RAG-backed. It is retrieval-backed and authorization-scoped (`knowledge-ai.e2e.spec.ts`), but retrieval is lexical, not embedding-based.
- [x] A tenant can run a challenge with leaderboard end-to-end — `community-challenges.e2e.spec.ts`.
- [x] An order and a subscription can be placed, renewed, paused, and cancelled; `OrderPlaced` / `OrderCompleted` / `SubscriptionRenewed` flow through the outbox — `commerce.e2e.spec.ts`, including the case that renewal cannot bill a cycle twice.
- [ ] AI CRM suggestions appear in the CRM UI — **not built, deliberately** (docs/33 §2 lists it under §35). Lead priority and next-best-action are predictions, and predicting from a pipeline with no history produces confident noise a salesperson would act on. It arrives when there is enough CRM history to evaluate a suggestion against what actually happened. Listed here as a goal AND there as a decision, which is why this line now says which it is.
- [x] Health data endpoints enforce `health.profile.*` — leaders, coaches and the tenant owner all get 403 without the member's grant, with no admin override (docs/13).
- [x] All Phase 1 gates still green — 164 API tests, 11 browser tests, four required CI checks.

---

## 4. Phase 3 — Growth & Compensation (spec §76)

### 4.1 Goals

Add the optional, configurable growth-economics layer — ranks, compensation, rewards, referral — without coupling it to the team graph, plus advanced AI coaching.

### 4.2 Modules added

- **Rank Engine** — `RankDefinition/Qualification/Progress/History/Requalification`; progress dashboard (current → next → missing requirements).
- **Compensation Rule Engine** — declarative IF/THEN rules over rank, volume, legs; all bonus types from spec §43; strictly tenant-configurable and optional.
- **Reward Engine** — non-monetary rewards decoupled from commissions (spec §45).
- **Referral Graph** — `ReferralRelationship` as its own graph, never coupled to Team or Compensation graphs (spec §17–§18, dev rules 8–9).
- **Leadership Journey** — configurable growth pathways with stage requirements (spec §23).
- **Advanced Automation** — full trigger-action workflow engine (spec §51).
- **AI Team Coach** — team growth/coaching insights, scope-obedient (spec §49).
- **AI Leadership Coach** — leader development suggestions.
- **Advanced Analytics** — cohort retention, growth correlation, tenant/platform dashboards.

### 4.3 Exit criteria

- [x] Two tenants run two _different_ compensation plans with zero code changes — `compensation.e2e.spec.ts`, and a third tenant that configured nothing has no surface at all.
- [x] A tenant with compensation disabled sees no compensation UI or API surface.
- [x] Team graph, referral graph, and compensation graph are independently editable; coupling tests assert it in every direction (`growth.e2e.spec.ts`, `compensation.e2e.spec.ts`).
- [x] Rank progress computes against configurable qualification rules — `growth.e2e.spec.ts`.
- [x] Commission runs are idempotent (unique per period), auditable (every entry stores its working), and reproducible (as-of traversal + frozen approvals).
- [x] AI Team Coach answers spec §49 questions only within the requesting leader's scope — `analytics.e2e.spec.ts`: the coach calls the same scoped service the leader dashboard calls, holds no database handle of its own, and is refused entirely to a member who leads nothing. Authorization precedes retrieval, so there is nothing to filter afterwards (docs/28 §4).
- [x] Automation workflows execute from spec §51's triggers via the outbox — every event in the shared `EVENTS` catalog is a legal trigger, and a rule naming an event the platform does not emit is **rejected at creation** rather than saved as a rule that could never fire (`automation.e2e.spec.ts`, docs/27 §1). Two deliberate departures from the wording: the pipeline is the outbox relay, not BullMQ (docs/11's upgrade, and docs/41 established the relay is not slow — it had been throttled); and an action with no adapter is refused at creation instead of silently ignored.

---

## 5. Phase 4 — Enterprise & Scale (spec §77)

### 5.1 Goals

Open the platform outward: multi-brand commerce, enterprise-grade tenancy, partner ecosystem, and white-label distribution.

### 5.2 Modules added

- **Multi-brand Marketplace** — cross-brand catalog, affiliate/external product links.
- **Corporate Wellness** — B2B tenant type with employer dashboards.
- **Partner Portal** — partner onboarding, revenue-share visibility.
- **API Marketplace** — public API + webhooks for third-party integrations.
- **Enterprise SSO** — SAML/OIDC federation per tenant.
- **Dedicated Enterprise Tenant Database** — execute the migration path reserved in ADR-002 for large tenants.
- **White-label Mobile App** — tenant-branded mobile distribution (from the PWA base).
- **Advanced AI Agents** — full agent roster from spec §48 with tool use.

### 5.3 Exit criteria

- [ ] One large tenant migrated to a dedicated database with zero data loss and bounded downtime. **Open, and staying open**: the routing seam, extract/verify tooling and runbook exist (docs/31–32), but there is no large tenant, no second host and no production traffic to bound downtime against. Ticking this because the code compiles is the claim that gets found out during an incident.
- [ ] Enterprise SSO login works for at least one federated tenant. **Open**: OIDC is verified against a fake provider with real RSA keys (`sso.e2e.spec.ts`); no real IdP has been used.
- [x] A third-party integration consumes the public API + webhooks end-to-end — `integration.e2e.spec.ts` drives a real in-process TLS receiver and verifies the signature it receives.
- [x] A white-label mobile build ships for at least one tenant — as a branded installable PWA (per-host manifest). Native store distribution is deliberately out of scope (docs/30 §5).
- [ ] Platform dashboard reports MRR/ARR/churn/AI cost per tenant. **Mostly**: members, tenants, churn and AI usage are real, and AI **cost** is now computed from tokens times a reviewed rate card, with a model that has no rate costing `null` and saying so rather than `0` (docs/36 §5). Storage and infrastructure cost still report as not-measured — nothing inside the app meters the machine it runs on, and a fabricated number is worse than a missing one.

---

## 6. The 12-Step AI Coding Process Mapped to the Roadmap (spec §83)

Do **not** start by generating hundreds of files. Each step completes and is verified for consistency before the next expands.

| Step | Activity                             | Where it lands on the roadmap                             |
| ---- | ------------------------------------ | --------------------------------------------------------- |
| 1    | Understand repository                | Sprint 0 — spec analysis, this docs suite                 |
| 2    | Generate architectural documentation | Sprint 0 — docs 01–23 (this suite)                        |
| 3    | Generate domain model                | Sprint 0 — `02-domain-map.md`, `08-data-model.md`         |
| 4    | Generate database schema             | Sprint 0 — base Prisma schema (identity + tenancy)        |
| 5    | Implement Tenant + Identity          | Sprint 1 — Slice 1 start                                  |
| 6    | Implement Membership                 | Sprint 1 — Slice 1                                        |
| 7    | Implement Team hierarchy             | Sprint 1–2 — Slice 1 (single level) → Slice 2 (recursive) |
| 8    | Implement Member Journey             | Sprint 2 — invite → register → activate → join team       |
| 9    | Implement Learning + CRM             | Sprint 2–3 — Slice 1 minimal learning; CRM basic          |
| 10   | Implement Dashboard                  | Sprint 3 — personal + team dashboards                     |
| 11   | Add AI Lite                          | Sprint 4 — basic assistant, scope-obedient                |
| 12   | Test complete vertical slice         | End of each slice — E2E + isolation suite gate            |

**Checkpoint rule:** stop after each major architectural milestone (end of each step 4, 7, 10, 12) and verify consistency — schema vs docs, tests vs spec — before expanding.

---

## 7. Standing Rules — The 20 Development Rules (spec §78)

These apply to every phase, every sprint, every PR. They are non-negotiable review criteria.

1. Never hard-code a tenant.
2. Never hard-code a company name.
3. Never hard-code Amway-specific (or any single vendor's) logic into Core.
4. Never hard-code a team depth.
5. Never hard-code a rank structure.
6. Never hard-code a membership structure.
7. Never hard-code a compensation plan.
8. Never couple Team Graph and Referral Graph.
9. Never couple Referral Graph and Compensation Graph.
10. Every tenant-owned record must be tenant-aware (`tenant_id` + RLS).
11. Every sensitive API must enforce tenant and permission scope.
12. All business rules must be configurable.
13. Build Modular Monolith first.
14. Use domain events (outbox `domain_events` + BullMQ).
15. Preserve historical organization relationships (effective dates, never destructive deletes).
16. Build mobile-first responsive UX.
17. Use accessibility best practices.
18. Build automated tests (see `17-test-strategy.md`).
19. Optimize for simplicity before scale.
20. Document all architectural decisions (see `20-adr.md`).

**Enforcement:** rules 1–12 are checked in code review on every PR touching domain code; rules 10–11 additionally by the tenant-isolation and permission test suites in CI; rule 20 by requiring an ADR entry for any decision that changes `20-adr.md`-level architecture.

---

## 8. Risks & Sequencing Notes

| Risk                               | Mitigation                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| RLS + Prisma integration is subtle | Sprint 0 spike: TenantContext middleware + `app.tenant_id` wiring proven with tests before any feature code |
| Closure-table bugs surface late    | Slice 2 is dedicated to hierarchy correctness with its own test suite                                       |
| Scope creep from the huge spec     | Phases gate on exit criteria; anything not in the current slice goes to backlog `Future`                    |
| Solo-dev burnout                   | Slices are individually shippable; each sprint ends with a working demo                                     |
| AI features leak unauthorized data | Authorization-before-retrieval enforced from AI Lite onward; AI permission tests are a CI gate              |
