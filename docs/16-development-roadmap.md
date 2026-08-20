# 16 — Development Roadmap

> **AVIORA** — phased delivery roadmap from Sprint 0 to the Phase 4 enterprise platform.
>
> Status: Approved · Last updated: 2026-08-19 · Source of truth: MASTER AI CODING PROMPT (spec §70–§78, §83–§84)

---

## Delivered so far (as-built, 2026-08-20)

The roadmap below is the plan; this table is what actually exists, so the two
never drift silently.

| Sprint | Scope                                                                                                                                                                                                                                              | State |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 0      | Monorepo, compose stack, CI + gitleaks, base schema, RLS + non-owner role, TenantContext, error envelope, idempotent seed                                                                                                                          | done  |
| 1      | Vertical Slice 1 — auth, tenant provisioning, plans + entitlements, invitations, teams, goals, learning, dashboard, audit, outbox + email                                                                                                          | done  |
| 2      | Vertical Slice 2 — recursive teams, scoped permissions, subtree move, direct vs organization rollups, leader dashboard                                                                                                                             | done  |
| 3      | CRM (configurable pipeline, conversion, follow-ups), notification centre, audit viewer                                                                                                                                                             | done  |
| 4      | Vertical Slice 3 — knowledge graph, brand-neutral journey, knowledge-first search, AI Lite with quotas and citations; content i18n (th/en)                                                                                                         | done  |
| 5      | MVP hardening — route-registry isolation sweep, ESLint module boundaries, multi-tenant-user proof, Playwright at a phone viewport                                                                                                                  | done  |
| 6      | **Phase 2 begins:** Healthy Living OS — habits, metrics, 30-day summary, consent-gated health privacy, PII field encryption                                                                                                                        | done  |
| 7      | Community (team spaces, posts, comments, reactions), Challenge engine (progress derived from habits/courses/goals), Gamification (configurable point rules, badges, leaderboards)                                                                  | done  |
| 8      | Commerce OS — catalogue on top of the knowledge graph, membership pricing as data, coupons, cart with snapshotted prices, provider-agnostic payments; Subscriptions at any interval with pause/skip/resume/cancel and idempotent renewal (docs/24) | done  |

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
  on a timer yet.

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

- [ ] The full §72 sequence runs end-to-end through the UI on staging.
- [ ] Two tenants exist; the tenant-isolation test suite passes (Tenant A can never read/write Tenant B).
- [ ] Playwright E2E covering the whole slice is green in CI.
- [ ] Every mutation in the flow produces an audit log row.

#### Vertical Slice 2 — recursive teams (spec §73)

```text
Team A → Team A1 → Team A1.1 → Team A1.1.1   (different leaders at each level)
```

Covers: team closure table under depth, team move, scoped permissions (`SELF / DIRECT_TEAM / DESCENDANT_TEAMS / SPECIFIC_TEAMS / TENANT_ALL`), team dashboard with direct vs organization metrics, leadership history.

**Slice 2 exit criteria**

- [ ] Parent leader sees authorized descendants; child leader cannot see unauthorized ancestors/siblings (test-asserted).
- [ ] Metrics roll up correctly across ≥4 levels (direct vs organization counts verified by test).
- [ ] Team move preserves closure correctness and history (dedicated test suite green).
- [ ] Tenant boundaries hold under hierarchy queries (isolation suite extended to team endpoints).

#### Vertical Slice 3 — knowledge-to-product journey (spec §74)

```text
Healthy Living Goal → Topic → Article → Ingredient → Product
(e.g. Better Sleep → Sleep Hygiene → Educational Article → Magnesium → Related Products)
```

Covers: minimal knowledge entities (`HealthGoal`, `Topic`, `Article`, `Ingredient`, `Product`, `Brand`), their relations, knowledge-first search ordering, brand neutrality (adding Brand B requires zero schema change).

**Slice 3 exit criteria**

- [ ] A member can navigate goal → topic → article → ingredient → product in the UI.
- [ ] Search ranks knowledge/articles above products (contract test).
- [ ] A second brand is seeded with no schema change (test proves brand neutrality).
- [ ] Global vs tenant knowledge visibility enforced.

### 2.4 MVP exit criteria — Definition of MVP Done (spec §84)

All of the following, each backed by an automated test where feasible:

- [ ] Platform Admin can create multiple tenants.
- [ ] Tenant data is isolated (isolation suite green — highest priority).
- [ ] One user can belong to multiple tenants (tenant switcher works).
- [ ] Tenant can create membership plans; entitlements gate capabilities.
- [ ] Tenant can invite members; members can register and activate membership.
- [ ] Tenant can create unlimited nested teams; members can belong to multiple teams.
- [ ] Teams have independent leaders; leaders manage authorized descendant teams only.
- [ ] Team hierarchy history is preserved (effective dates, never destructive).
- [ ] Member can create goals and follow a learning journey.
- [ ] CRM supports leads and follow-up.
- [ ] Dashboard shows personal and team progress (direct vs organization metrics).
- [ ] Roles and permissions work, including scope levels.
- [ ] AI respects tenant and team permissions (AI permission tests green).
- [ ] Audit logs capture all sensitive actions.
- [ ] Mobile UX is usable (mobile-first responsive, th/en).
- [ ] Automated tenant-isolation tests pass in CI as a required gate.

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
- [ ] AI CRM suggestions appear in the CRM UI — not started.
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

- [ ] Two tenants run two _different_ compensation plans with zero code changes (config only).
- [ ] A tenant with compensation disabled sees no compensation UI or API surface.
- [ ] Team graph, referral graph, and compensation graph are independently editable; coupling tests prove no cross-contamination.
- [ ] Rank progress computes correctly against configurable qualification rules (rule-engine test matrix green).
- [ ] Commission runs are idempotent, auditable, and reproducible from event history.
- [ ] AI Team Coach answers spec §49 questions only within the requesting leader's scope (AI permission tests).
- [ ] Automation workflows execute from all spec §51 triggers via the outbox/BullMQ pipeline.

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

- [ ] One large tenant migrated to a dedicated database with zero data loss and bounded downtime (rehearsed on staging first).
- [ ] Enterprise SSO login works for at least one federated tenant.
- [ ] A third-party integration consumes the public API + webhooks end-to-end.
- [ ] A white-label mobile build ships for at least one tenant.
- [ ] Platform dashboard reports MRR/ARR/churn/AI cost per tenant accurately.

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
