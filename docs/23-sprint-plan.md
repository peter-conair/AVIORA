# 23 — Sprint Plan: Sprint 0 & Sprint 1

> **AVIORA** — the first two sprints: foundation week, then Vertical Slice 1 end-to-end.
>
> Status: Approved · Last updated: 2026-08-19 · Source of truth: MASTER AI CODING PROMPT (spec §72, §83, FINAL INSTRUCTION 13–15) · Backlog IDs reference `22-development-backlog.md`

Team: **one senior developer + AI assistance.** Estimates are ideal days; AI assistance is expected to compress scaffold-heavy work (codegen, boilerplate, test harnesses) by roughly 1.5–2×, which is what makes these sprints feasible. Where a story is delivered "thin", the thin scope is stated explicitly — the full story remains in the backlog.

---

## Sprint 0 — Foundation Week

**Dates:** Mon 2026-08-24 → Fri 2026-08-28 (1 week)
**Goal:** _A fresh clone can boot the full local stack, CI enforces all gates, and tenant isolation is proven at the database level — before any feature exists._
**Maps to:** AI coding process steps 1–4 (understand repo, docs, domain model, database schema — spec §83). Docs 01–23 are completed as part of this sprint.

### Sprint 0 backlog

| #   | Story                                    | Scope in Sprint 0                                                                                                                                                                                                                  | Ideal d  |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | E00-S1 Monorepo scaffold                 | pnpm + Turborepo; `apps/web` (Next.js 15, TS, Tailwind, PWA base, next-intl th/en), `apps/api` (NestJS 11), `packages/db` (Prisma), `packages/shared`, `packages/config`; ESLint boundaries                                        | 1.5      |
| 2   | E00-S2 docker-compose stack              | postgres:17-alpine (protected volume), redis (password), api, web; `TZ=UTC`; healthchecks; `.env.example`                                                                                                                          | 1.0      |
| 3   | E00-S3 CI + security day-1               | GitHub Actions: lint → typecheck → gitleaks → unit → integration; husky pre-commit (gitleaks L1 + lint-staged); `.gitignore` with env/credential patterns + `!.env.example`; `.gitleaks.toml`; branch protection                   | 1.5      |
| 4   | E00-S4 Base Prisma schema                | identity + tenancy tables (`tenants, tenant_settings, users, tenant_memberships, members, roles, permissions, role_permissions, audit_logs, domain_events`); snake_case, uuid v7, timestamptz; fixture factory (tenant_alpha/beta) | 2.0      |
| 5   | E00-S5 RLS + app role                    | Policies FORCED on tenant-owned tables bound to `app.tenant_id`; non-owner app role; pg_policies meta-test                                                                                                                         | 2.0      |
| 6   | E00-S6 TenantContext + RLS wiring        | Middleware resolving subdomain/JWT/`X-Tenant-ID`; Prisma extension with `SET LOCAL app.tenant_id` transaction; worker context helper                                                                                               | 2.0      |
| 7   | E00-S7 Error envelope + logging skeleton | Global exception filter; pino JSON logs with `request_id/tenant_id/user_id`; request-id middleware                                                                                                                                 | 1.0      |
| 8   | E00-S8 Seed script skeleton              | Idempotent runner; platform roles, permission catalog, entitlement catalog, platform admin user                                                                                                                                    | 1.0      |
|     | **Total**                                |                                                                                                                                                                                                                                    | **12.0** |

12 ideal days into one calendar week is the sprint's stretch: items 1–3 are scaffold-heavy (highest AI compression), and items 5–6 are the week's true engineering core — they get the deepest focus. If anything slips, it is items 7–8 (small, well-defined) that roll into Sprint 1 Day 1 — **never** items 5–6: proven isolation is the sprint goal and is not negotiable.

### Suggested day plan

| Day | Focus                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Mon | E00-S1 monorepo scaffold; repo pushed; boundary lint on                                                                                    |
| Tue | E00-S2 compose stack; E00-S3 CI + hooks + gitleaks (verify with planted secret)                                                            |
| Wed | E00-S4 schema + migration + fixture factory                                                                                                |
| Thu | E00-S5 RLS policies + role; RLS test suite green (the week's key milestone)                                                                |
| Fri | E00-S6 TenantContext wiring + isolation integration tests; E00-S7/S8 skeletons; consistency checkpoint (spec §83: verify before expanding) |

### Sprint 0 Definition of Done

- [ ] Fresh clone → `pnpm install && docker compose up && pnpm dev` boots web + api against local Postgres/Redis.
- [ ] CI runs lint, typecheck, gitleaks, unit, integration on every PR; all checks required on `main`; direct pushes blocked.
- [ ] Planted fake secret is blocked at pre-commit (L1) **and** in CI (L2).
- [ ] Base migration applies cleanly on compose DB and testcontainers; zero `timestamp without time zone` columns (meta-test).
- [ ] RLS suite green **as the non-owner app role**: alpha context sees only alpha rows; unset context sees zero rows; pg_policies meta-test passes.
- [ ] TenantContext resolves from subdomain and header with correct precedence; forged `X-Tenant-ID` cannot widen access (integration test).
- [ ] All API errors return the standard envelope; logs are structured JSON with the three ids.
- [ ] Seed script runs twice with identical resulting state.
- [ ] Docs 01–23 committed; ADR log (`20-adr.md`) reflects all thirteen decisions.
- [ ] No secret values anywhere in the repo; `.env.example` placeholders only.

---

## Sprint 1 — Vertical Slice 1 End-to-End

**Dates:** Mon 2026-08-31 → Fri 2026-09-11 (2 weeks)
**Goal:** _The complete spec §72 journey runs through the real UI on the local stack — Platform Admin creates a tenant, and a member invited into it registers, joins Team A, creates a goal, starts a course, completes a task, and watches the dashboard update — with tenant isolation proven at the API level._
**Maps to:** AI coding process steps 5–10 thin (Tenant + Identity → Membership → Team → Member journey → Learning → Dashboard) + step 12 (test the slice).

### Sprint 1 backlog

Stories are P0 backlog items; "thin" columns state Sprint-1 scope where the full story is larger.

| #   | Story                                          | Sprint-1 scope                                                                                                                                | Ideal d                                            |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | E01-S1 Registration (Argon2id)                 | Full                                                                                                                                          | 1.0                                                |
| 2   | E01-S2 Login/logout/refresh (HttpOnly cookies) | Full                                                                                                                                          | 1.5                                                |
| 3   | E01-S3 RBAC roles + guards                     | Full (custom-role UI deferred to P2)                                                                                                          | 2.0                                                |
| 4   | E02-S1 Platform admin creates tenant           | Full, minimal admin UI                                                                                                                        | 1.5                                                |
| 5   | E02-S2 Tenant configuration                    | Thin: name/language/timezone settings; logo upload deferred                                                                                   | 0.5                                                |
| 6   | E02-S3 Create tenant admin                     | Full                                                                                                                                          | 1.0                                                |
| 7   | E03-S1 Membership plan CRUD                    | Full, minimal admin UI                                                                                                                        | 1.5                                                |
| 8   | E03-S2 Entitlements + plan mapping             | Thin: catalog + resolution + `course.access` gate wired; mapping UI minimal                                                                   | 1.0                                                |
| 9   | E03-S3 Invite member                           | Full (email via E08-S1)                                                                                                                       | 1.0                                                |
| 10  | E03-S4 Registration + membership activation    | Full (both new/existing user paths; events to outbox)                                                                                         | 2.0                                                |
| 11  | E03-S5 Member profile                          | Thin: view/edit name + locale; avatar/custom fields deferred                                                                                  | 0.5                                                |
| 12  | E04-S1 Create Team A (+ closure self-row)      | Full                                                                                                                                          | 1.5                                                |
| 13  | E04-S2 Assign Leader A                         | Full                                                                                                                                          | 1.0                                                |
| 14  | E04-S3 Member joins team                       | Full                                                                                                                                          | 1.0                                                |
| 15  | E05-S1 Member creates goal                     | Full                                                                                                                                          | 1.5                                                |
| 16  | E06-S1 Course + lessons                        | Thin: seeded demo course + minimal authoring form                                                                                             | 1.0                                                |
| 17  | E06-S2 Start course, complete task             | Full (entitlement-gated)                                                                                                                      | 1.5                                                |
| 18  | E08-S1 Transactional email via worker          | Full (invite/welcome templates; fake transport in tests)                                                                                      | 1.5                                                |
| 19  | E09-S1 Personal dashboard                      | Full                                                                                                                                          | 1.5                                                |
| 20  | E11-S1 Audit pipeline                          | Full for slice-1 sensitive actions                                                                                                            | 1.5                                                |
| 21  | Slice-1 hardening                              | API-level isolation suite over all new endpoints (route registry + meta-test); Playwright E2E of the full §72 journey; consistency checkpoint | 2.0                                                |
|     | **Total**                                      |                                                                                                                                               | **~28 → target ≤ 20 effective with AI assistance** |

~28 ideal days into 10 working days assumes the AI-compression factor on CRUD/scaffold stories (items 4–17 are heavily patterned: entity → endpoints → guard → tests → thin UI, generated against the conventions established in Sprint 0). The two non-compressible cores get protected time: **E03-S4** (membership state machine + outbox events) and **item 21** (isolation suite + E2E). De-scope order if the sprint runs hot: item 5 → item 11 → item 16 authoring form (keep the seeded course) — never item 21.

### Week plan

| Week                   | Focus                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1 (08-31 → 09-04)** | Identity (items 1–3) → platform admin + tenant (4–6) → plans + entitlements (7–8). Milestone Fri: platform admin creates tenant + plan + tenant admin through the UI; auth cookies + guards fully tested.                                     |
| **W2 (09-07 → 09-11)** | Invites + registration/activation (9–11, 18) → team (12–14) → goal + learning (15–17) → dashboard (19) → audit (20) → hardening + E2E (21). Milestone Thu: full journey manually green; Fri: E2E + isolation suite green, sprint review demo. |

### Sprint review demo script (Fri 2026-09-11)

1. **Platform Admin** logs in at `admin.aviora.local` → creates tenant **"Wellness One"** (`wellness-one`) → sets language th, timezone Asia/Bangkok → creates plan **"Starter"** (trial 14 d, entitlements incl. `course.access`) → creates Tenant Admin **Nok**.
2. **Nok** logs in at `wellness-one.aviora.local` → creates **Team A** → assigns herself **Leader** → invites **pong@example.com** on plan Starter.
3. **Pong** opens the invite email (mailpit) → registers → membership activates (trial) → joins Team A → creates goal **"Sleep 7 hours"** → opens the seeded course → completes lesson task 1.
4. **Dashboard:** Pong's dashboard shows the goal, course progress, and completed task — updated immediately.
5. **Isolation proof (the closer):** a second tenant **"Beta Club"** exists with its own data. Logged in as Nok, attempt to fetch a Beta Club team/member by id → **404**; run the isolation suite live in the terminal → green. Show the audit trail of everything just performed.

### Sprint 1 Definition of Done

- [ ] The complete spec §72 sequence runs end-to-end through the UI on the compose stack (and staging, if provisioned).
- [ ] Playwright E2E of the Slice 1 journey is green and required in CI.
- [ ] Tenant-isolation suite covers **every** endpoint shipped this sprint (route-registry meta-test proves none is missing) and is a required CI gate.
- [ ] `MemberRegistered`, `MembershipActivated`, `TeamCreated`, `LeaderAssigned`, `MemberJoinedTeam`, `GoalCreated`, `CourseStarted` events written to the outbox exactly once each along the journey; worker relays them (email consumer live, others logged).
- [ ] Every sensitive mutation in the journey has an audit row with before/after and request_id.
- [ ] All capability checks use entitlements — zero plan-name branching (review + lint).
- [ ] Unit coverage on new domain logic ≥ 80% (Vitest thresholds); all CI gates green.
- [ ] No hard-coded tenant, brand, depth, or plan anywhere (dev rules 1–7 review pass).
- [ ] Journey screens usable at 360 px width; strings in i18n catalogs (th may lag en, no raw strings in JSX).
- [ ] Demo script above performed in sprint review; consistency checkpoint (spec §83) recorded: schema ↔ docs ↔ tests aligned before Sprint 2 (Slice 2: recursive teams) begins.

---

## Looking Ahead (not committed)

- **Sprint 2 (2 w):** Vertical Slice 2 — recursive hierarchy, team move, scoped permissions, rollup metrics (E04-S4..S7, E09-S2..S3).
- **Sprint 3 (2 w):** CRM + notifications center + tenant switcher + audit viewer (E07, E08-S2, E01-S4, E11-S2).
- **Sprint 4 (2 w):** Vertical Slice 3 — knowledge journey + AI assistant with quotas (E12, E10).
- **Sprint 5 (1–2 w):** P2 polish → Definition of MVP Done checklist (`16-development-roadmap.md` §2.4).
