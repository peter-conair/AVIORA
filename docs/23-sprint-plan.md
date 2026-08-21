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

- [x] Fresh clone boots web + api — CI does exactly this on every push: fresh checkout, `pnpm install --frozen-lockfile`, migrate, start both servers for the browser job.
- [ ] CI runs lint, typecheck, gitleaks, unit, integration on every PR; all checks required on `main`; direct pushes blocked. **Half true, and the half that is missing is a decision, not a task**: four checks are required on `main` and force-pushes are blocked, but `enforce_admins` is off, so an administrator can push straight to `main` and bypass them. Turning it on makes every change — including an administrator's — go through a PR. That is a workflow choice for the repository owner.
- [x] Planted fake secret is blocked at L1 and L2 — gitleaks runs in the pre-commit hook on every commit and as the required "scan for credentials" check. The planting itself is a manual drill (`~/.claude/rules/gitleaks-mandatory.md`), not an automated test: a repo that commits a fake secret to prove it cannot has committed a fake secret.
- [x] Migrations apply cleanly and there are zero naive timestamp columns — `schema-meta.spec.ts` asserts `timestamptz` on every temporal column and fails on a new table that forgets it.
- [x] RLS suite green as the non-owner app role — `tenant-isolation.spec.ts`, plus `route-coverage.spec.ts` driving every tenant-scoped route against a foreign tenant..
- [x] TenantContext precedence, and a forged `X-Tenant-ID` cannot widen access — `tenant-isolation.spec.ts`. The guard additionally requires MEMBERSHIP on permission-free tenant routes, which is what stops a header from being enough.
- [x] Standard error envelope, and structured logs carrying request/tenant/user — the envelope is asserted across the suites; the three ids were completed in docs/36 §2, taken from what the guards RESOLVED rather than from the header a caller sent.
- [x] Seed runs twice with identical state — `seed-idempotence.spec.ts` executes it as a child process, the way a deploy runs it, and compares a full snapshot. It had been claimed in docs/17 §15 and tested nowhere, which matters because the seed is the one script that touches a production database unattended.
- [x] Docs committed; `20-adr.md` carries thirteen ADRs.
- [x] No secret values in the repo — gitleaks is clean on every commit and `.env.example` holds placeholders with a note on where each value comes from.

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

- [x] The §72 sequence runs end-to-end through the UI on the compose stack — `apps/web/e2e/vertical-slice-journey.spec.ts`. Staging is not provisioned, so that clause is untested and stays that way until one exists.
- [x] Playwright E2E of the Slice 1 journey is green and required in CI — "browser E2E (mobile viewport)".
- [x] Tenant isolation covers every endpoint via the route-registry sweep, and is a required CI gate.
- [x] All seven journey events are written to the outbox and relayed — asserted in `vertical-slice.e2e.spec.ts`; events written to the outbox exactly once each along the journey; worker relays them (email consumer live, others logged).
- [x] Every sensitive mutation has an audit row with a request id — `vertical-slice.e2e.spec.ts` for the journey's eight actions, and `audit-coverage.spec.ts` sweeping all 103 mutating routes so a new one cannot be silent. **`before`/`after` is not universal**: it is recorded where a value changed and omitted on creation, where there is no "before" to state.
- [x] Capability checks use entitlements, with zero plan-name branching — no `plan.code ===` or `plan.name ===` exists in `apps/api/src`. It is enforced by review rather than by a lint rule, which is worth knowing: the check above is a grep, not a gate.
- [x] Coverage ≥ 80%, measured where the tests are — **90.6% statements, 95.0% functions, 79.5% branches** under the integration suite (`pnpm --filter @aviora/api test:coverage`, thresholds configured). Measured on the UNIT runner it is 2.7%, and that is the design rather than a gap: this codebase tests behaviour through real HTTP against a real database, so asking the unit runner is asking the wrong instrument.
- [x] No hard-coded tenant, brand, depth or plan — brands are rows (proved by the seed shipping two and `marketplace.e2e` asserting neutrality), depth is a closure table, plans are entitlements. Enforced by review and by the tests that would break, not by a linter.
- [x] Journey screens usable at 360 px — `narrow-viewport.spec.ts` runs a dedicated Playwright project at 360×800 over sign-in, the journey screens, the admin tabs and the bottom bar. The rest of the browser suite runs at a Pixel 7, which is 412 px and would not have caught an overflow at 360.
- [ ] Demo script performed in sprint review; consistency checkpoint (spec §83) recorded. **Not verifiable from the repository** — it is a meeting, and no artefact here can prove it happened. The schema ↔ docs ↔ tests half is continuously enforced by `schema-meta.spec.ts`, `route-coverage.spec.ts` and `audit-coverage.spec.ts`, each of which fails when the code and the documents disagree. (Slice 2: recursive teams) begins.

---

## Looking Ahead (not committed)

- **Sprint 2 (2 w):** Vertical Slice 2 — recursive hierarchy, team move, scoped permissions, rollup metrics (E04-S4..S7, E09-S2..S3).
- **Sprint 3 (2 w):** CRM + notifications center + tenant switcher + audit viewer (E07, E08-S2, E01-S4, E11-S2).
- **Sprint 4 (2 w):** Vertical Slice 3 — knowledge journey + AI assistant with quotas (E12, E10).
- **Sprint 5 (1–2 w):** P2 polish → Definition of MVP Done checklist (`16-development-roadmap.md` §2.4).
