# 22 — Development Backlog

> **AVIORA** — full MVP backlog: Epic → Feature → User Story → Acceptance Criteria → Technical Tasks → Test Cases, with Priority / Dependencies / Estimate.
>
> Status: Approved · Last updated: 2026-08-19 · Source of truth: MASTER AI CODING PROMPT (spec §71–§74, §82, §84)

---

## How to Read This Backlog

- **Priority bands:** **P0** = everything needed for Vertical Slice 1 (spec §72) including Sprint 0 foundation · **P1** = Slices 2–3 + the remaining MVP modules · **P2** = MVP polish before Definition of MVP Done · **Future** = Phase 2+ headline epics only (detailed when their phase begins).
- **Estimates** are **ideal days** for one senior developer with AI assistance. A story includes its tests (a story is not done until its test cases pass — dev rule 18).
- **IDs:** `E##` epic · `E##-F#` feature · `E##-S#` story. Dependencies reference story IDs.
- Standing constraints on _every_ story: tenant-aware (`tenant_id` + RLS), permission-scoped, audit-logged where sensitive, mobile-first UI, no hard-coded tenant/brand/depth/plan logic (dev rules 1–12).

**Backlog totals: 59 stories · P0: 28 (~39.5 d) · P1: 21 (~32 d) · P2: 10 (~12 d) · Future: 4 headline epics**

---

## P0 — Foundation + Vertical Slice 1

### E00 — Epic: Project Foundation (Sprint 0)

> Everything required before feature work. Detail lives in `23-sprint-plan.md`.

#### E00-F1 — Feature: Repository & Toolchain

**E00-S1 — Monorepo scaffold** · P0 · deps: — · **1.5 d**
As the developer, I want a pnpm + Turborepo monorepo with `apps/web` (Next.js 15, TS, Tailwind, PWA, next-intl th/en), `apps/api` (NestJS 11), `packages/db` (Prisma), `packages/shared`, `packages/config`, so every later story lands in a coherent structure.

- **AC:** `pnpm install && pnpm build && pnpm test` pass from a fresh clone; Turbo caches tasks; web boots on :3000, api on :3001; th/en locale switch renders.
- **Tech tasks:** init workspace + turbo.json; scaffold both apps; shared tsconfig/ESLint/Tailwind presets in `packages/config`; ESLint module-boundary rules; README quickstart.
- **Tests:** CI green on scaffold; boundary lint fails on an illegal cross-package import (fixture).

**E00-S2 — Local docker-compose stack** · P0 · deps: E00-S1 · **1 d**
As the developer, I want `docker compose up` to start postgres:17-alpine, redis, api, web so local development matches production shape.

- **AC:** all four services healthy; `TZ=UTC` everywhere; pgdata volume persists across restarts; Redis requires password.
- **Tech tasks:** compose file per `18-deployment-architecture.md` §1.1; healthchecks; `.env.example` with placeholders only; Makefile/scripts.
- **Tests:** compose config validated in CI; smoke script hits `/healthz` of api and web.

**E00-S3 — CI pipeline + security hygiene (day 1)** · P0 · deps: E00-S1 · **1.5 d**
As the developer, I want CI (lint → typecheck → gitleaks → unit → integration) and day-1 secret hygiene so no credential ever lands in git.

- **AC:** GitHub Actions runs all gates on PR; gitleaks L1 (pre-commit via husky) blocks a planted fake secret; `.gitignore` covers env/credential patterns with `!.env.example` negation; branch protection: no direct push to main.
- **Tech tasks:** workflow yaml; `.gitleaks.toml`; husky + pre-commit (gitleaks, lint-staged typecheck); required checks config.
- **Tests:** planted-secret commit blocked locally and in CI; red lint blocks merge (verified once).

#### E00-F2 — Feature: Data Layer & Tenant Isolation Skeleton

**E00-S4 — Base Prisma schema (identity + tenancy)** · P0 · deps: E00-S2 · **2 d**
As the developer, I want the base schema — `tenants, tenant_settings, users, tenant_memberships, members, roles, permissions, role_permissions, audit_logs, domain_events` — snake_case, uuid v7 PKs, timestamptz, `tenant_id` on all tenant-owned tables.

- **AC:** `prisma migrate dev` produces the schema; uuid v7 generated app-side; every temporal column is timestamptz; migration applies on the compose DB and on testcontainers.
- **Tech tasks:** schema.prisma with `@@map`/`@map` snake_case; uuid v7 helper in `packages/db`; migration; fixture factory for `tenant_alpha`/`tenant_beta`.
- **Tests:** meta-test: no `timestamp without time zone` in information_schema; fixture factory round-trips.

**E00-S5 — RLS policies + non-owner app role** · P0 · deps: E00-S4 · **2 d**
As the platform, I want RLS enabled and FORCED on every tenant-owned table, bound to `app.tenant_id`, with the app connecting as a non-owner role, so isolation holds below the ORM.

- **AC:** with `app.tenant_id=alpha` only alpha rows visible/mutable; with it unset, zero rows (fail-closed); RLS-exempt tables (users, tenants, global reference) explicitly catalogued.
- **Tech tasks:** SQL migration creating app role + policies; policy template for future tables; RLS meta-test scaffolding (`pg_policies` check).
- **Tests:** RLS suite per `17-test-strategy.md` §6.2 green; meta-test fails when a new tenant table lacks a policy (fixture-verified).

**E00-S6 — TenantContext middleware + Prisma RLS wiring** · P0 · deps: E00-S5 · **2 d**
As the platform, I want every request to resolve TenantContext (subdomain → custom domain → JWT claim → `X-Tenant-ID` for internal calls) and execute queries inside a transaction with `SET LOCAL app.tenant_id`.

- **AC:** context resolvable from all four sources with defined precedence; header can never widen access beyond the caller's TenantMembership; requests without resolvable tenant hit only public/platform routes; worker jobs establish context from job payload.
- **Tech tasks:** Nest middleware + `TenantContext` provider (request-scoped); Prisma client extension wrapping calls in `SET LOCAL` transaction; route classification (public/platform/tenant); worker context helper.
- **Tests:** integration: forged header rejected; unset context reads zero tenant rows; two parallel requests for different tenants don't bleed (connection-pool test).

**E00-S7 — Error envelope + structured logging + request tracing** · P0 · deps: E00-S1 · **1 d**
As the developer, I want a standard error envelope `{error: {code, message, details?, request_id}}` and JSON logs carrying `request_id`, `tenant_id`, `user_id` on every line.

- **AC:** all thrown errors serialize to the envelope; validation errors include field details; logs are structured JSON; request_id propagates via header and into outbox/audit rows.
- **Tech tasks:** global exception filter; pino logger with context bindings; request-id middleware; contract-test helper asserting envelope generically.
- **Tests:** contract tests: 400/401/403/404/500 all envelope-shaped; log line snapshot contains the three ids.

**E00-S8 — Idempotent seed script skeleton** · P0 · deps: E00-S4 · **1 d**
As the developer, I want `pnpm --filter db seed` to idempotently upsert reference data (platform roles, permission catalog, entitlement catalog, platform admin user) so environments are reproducible.

- **AC:** running twice yields identical row counts and state; safe against a live database; wired into post-deploy pipeline.
- **Tech tasks:** seed runner with upsert-by-natural-key pattern; catalogs in `packages/shared`; document "seed is the only home for reference data".
- **Tests:** double-run idempotency test; seed runs green inside CI integration job.

---

### E01 — Epic: Identity & Access (MVP modules 1, 6)

#### E01-F1 — Feature: Authentication

**E01-S1 — User registration with Argon2id** · P0 · deps: E00-S6 · **1 d**
As a visitor with an invitation, I want to register with email + password so I can access my tenant.

- **AC:** password hashed with Argon2id (tuned params); email unique globally (User is global — ADR-004); weak passwords rejected (zxcvbn threshold); `MemberRegistered` written to outbox when registration completes an invite.
- **Tech tasks:** register endpoint + DTO validation (zod/class-validator); Argon2id service; rate limit on auth routes.
- **Tests:** unit: hashing/verification; integration: duplicate email 409; contract: envelope on validation failure.

**E01-S2 — Login / logout / refresh with HttpOnly cookies** · P0 · deps: E01-S1 · **1.5 d**
As a user, I want to log in and stay signed in securely so my session can't be stolen by script.

- **AC:** access JWT ~15 min + rotating refresh token, both `HttpOnly; Secure; SameSite=Lax` (ADR-013); refresh rotation invalidates the used token; logout revokes the session; failed logins rate-limited and audited.
- **Tech tasks:** JWT module + cookie issuance; refresh-token store (hashed) + rotation; auth guard reading cookie; logout/logout-all.
- **Tests:** integration: full login→refresh→logout cycle; reused refresh token rejected; cookie flags asserted; 401 without cookie on protected route.

**E01-S3 — RBAC roles, permissions & guards** · P0 · deps: E01-S2, E00-S8 · **2 d**
As the platform, I want roles mapped to permission strings, enforced by guards on every non-public route, so authorization is uniform.

- **AC:** platform roles (Platform Owner, Super Admin, Support) and tenant roles (Tenant Owner, Tenant Admin, Leader, Member, …) seeded; permission checks resolve server-side per request (not from JWT claims); tenants can create custom roles (data model ready; UI is P2).
- **Tech tasks:** `@RequirePermission()` decorator + guard; role/permission resolution service with per-request cache; permission catalog in `packages/shared`; deny-by-default route audit (meta-test lists unguarded routes).
- **Tests:** matrix tests role×permission; meta-test: every controller route is public-listed or guarded; escalation attempt (self-role-edit) denied + audited.

#### E01-F2 — Feature: Multi-Tenant Identity

**E01-S4 — Tenant switcher** (MVP module 3) · P1 · deps: E01-S2, E03-S4 · **1 d**
As a user belonging to multiple tenants, I want to switch my active tenant so I can act in each of my roles.

- **AC:** switcher lists only tenants where I hold an active TenantMembership; switching re-issues the access token with new tenant context; all subsequent data reflects the new tenant only.
- **Tech tasks:** `GET /me/tenants`; `POST /auth/switch-tenant`; web switcher component in shell.
- **Tests:** E2E: one user, two tenants, fully separate data after switch; integration: switching to a non-member tenant → 403.

---

### E02 — Epic: Tenant & Platform Admin (MVP modules 2, 14)

#### E02-F1 — Feature: Tenant Lifecycle

**E02-S1 — Platform admin creates tenant** · P0 · deps: E01-S3 · **1.5 d**
As a Platform Admin, I want to create a tenant (code, name, slug, type, country, timezone, language, currency) so a new organization can onboard.

- **AC:** slug unique, drives `{slug}.aviora.app` resolution; `TenantCreated` event emitted; tenant starts in `active` with default settings; creation audited.
- **Tech tasks:** platform-scoped controller (`/api/v1/platform/tenants`); tenant entity per spec §5; default settings bootstrap; platform admin UI page.
- **Tests:** integration: create + resolve by subdomain; isolation: tenant admin of alpha cannot hit platform routes; audit row asserted.

**E02-S2 — Tenant configuration (settings & branding basics)** · P0 · deps: E02-S1 · **1 d**
As a Tenant Admin, I want to configure name, logo, colors, default language/timezone so the workspace feels like ours.

- **AC:** settings persist per tenant; logo uploads to R2 under `/tenants/{id}/...` via signed URL; branding applies to web shell; changes audited.
- **Tech tasks:** tenant settings endpoints; R2 signed-upload service; web settings page + theme application.
- **Tests:** isolation: alpha admin cannot read/write beta settings (404); R2 key prefix asserted; audit on change.

**E02-S3 — Create Tenant Admin user** · P0 · deps: E02-S1, E01-S1 · **1 d**
As a Platform Admin, I want to create the first Tenant Admin (new or existing User) so the tenant can self-manage.

- **AC:** existing user gets a TenantMembership + Tenant Admin role; new user gets an invite email with secure one-time token; admin can log in and lands in their tenant.
- **Tech tasks:** admin-invite flow reusing invitation infrastructure (E03-S3); role assignment; audit.
- **Tests:** integration: both paths (new/existing user); token single-use + expiry; E2E covered in Slice 1 journey.

---

### E03 — Epic: Membership (MVP modules 4, 5)

#### E03-F1 — Feature: Plans & Entitlements

**E03-S1 — Membership plan CRUD** · P0 · deps: E02-S3 · **1.5 d**
As a Tenant Admin, I want to create membership plans (code, name, type, price, currency, billing cycle, trial days, status) so my organization defines its own membership structure.

- **AC:** arbitrary plan names/types supported (dev rule 6); plans are tenant-scoped; archive instead of delete once memberships exist; audited.
- **Tech tasks:** plan entity per spec §8; CRUD endpoints + admin UI; status lifecycle (draft/active/archived).
- **Tests:** isolation on plan endpoints; archive-with-members rule; contract tests.

**E03-S2 — Entitlement catalog & plan mapping** · P0 · deps: E03-S1 · **1.5 d**
As a Tenant Admin, I want to attach entitlements (e.g. `course.access`, `team.create`, `ai.coach`) to plans so capabilities never depend on plan names (ADR-005).

- **AC:** entitlement catalog seeded from `packages/shared`; plan↔entitlement mapping editable; `hasEntitlement()` helper used by guards; member's effective entitlements resolve from their active membership and are cached with invalidation on change.
- **Tech tasks:** entitlement + plan_entitlement tables; resolution service + cache; `@RequireEntitlement()` guard; admin mapping UI.
- **Tests:** unit: resolution incl. cache invalidation; integration: endpoint gated by entitlement flips when plan mapping changes; no code path branches on plan name (lint rule + review checklist).

#### E03-F2 — Feature: Member Onboarding

**E03-S3 — Invite member** · P0 · deps: E03-S1, E08-S1 · **1 d**
As a Tenant Admin, I want to invite a person by email with a chosen plan so they can join my tenant.

- **AC:** invitation stores tenant, email, plan, expiry; email sent with secure token link; re-invite regenerates token; invites are listable/revocable.
- **Tech tasks:** invitation entity + endpoints; token generation (hashed at rest); admin invite UI.
- **Tests:** token single-use, expiry, revocation; isolation: invites are tenant-scoped; email dispatch asserted via fake transport.

**E03-S4 — Member registration & membership activation** · P0 · deps: E03-S3, E01-S1 · **2 d**
As an invited person, I want to register (or attach my existing account) and have my membership activated so I become a Member of the tenant.

- **AC:** flow handles both new user and existing user (ADR-004); on completion: TenantMembership active, Member record created, Membership active on the invited plan (trial honored); `MemberRegistered` + `MembershipActivated` events in outbox; member lands on onboarding/dashboard.
- **Tech tasks:** registration-via-invite endpoint; membership state machine (invited→active, trial); Member 360 base record; web registration flow.
- **Tests:** lifecycle suite (both user paths, trial, illegal transitions); events asserted in outbox exactly once; E2E in Slice 1 journey.

**E03-S5 — Member profile** · P0 · deps: E03-S4 · **1 d**
As a Member, I want to view and edit my profile (name, avatar, locale, contact) so my identity in this tenant is mine.

- **AC:** profile is per-tenant (Member), not global (User); avatar in R2 member-private path; tenant-specific custom fields supported via jsonb `metadata`.
- **Tech tasks:** profile endpoints + web page; custom-field render; R2 upload.
- **Tests:** isolation: member A cannot read member B's private fields without permission; R2 path prefix asserted.

---

### E04 — Epic: Team & Organization (MVP modules 7, 8)

#### E04-F1 — Feature: Teams (Slice 1 — single level)

**E04-S1 — Create team + closure self-row** · P0 · deps: E02-S3 · **1.5 d**
As a Tenant Admin, I want to create Team A (code, name, type, visibility) so my organization has structure.

- **AC:** team created with `parent_team_id = NULL`; closure self-row (depth 0) written transactionally; `TeamCreated` event; audited.
- **Tech tasks:** team entity per spec §12; closure maintenance service (create path); endpoints + admin UI.
- **Tests:** closure invariant checker green after create; isolation on team endpoints.

**E04-S2 — Assign team leader** · P0 · deps: E04-S1, E03-S4 · **1 d**
As a Tenant Admin, I want to assign Leader A to Team A with an effective date so leadership is explicit and historical.

- **AC:** TeamLeadership row (role, is_primary, effective_from) created; replacing a primary leader end-dates the old row — never deletes (dev rule 15); `LeaderAssigned` event; audited.
- **Tech tasks:** leadership entity per spec §14; assign/replace endpoints + UI; history listing.
- **Tests:** history preserved on change; two primaries rejected; audit row asserted.

**E04-S3 — Add member to team** · P0 · deps: E04-S1, E03-S4 · **1 d**
As a Tenant Admin or authorized Leader, I want to add a member to a team with a role so they participate in the structure.

- **AC:** TeamMembership row (member may join multiple teams — no team_id on Member, spec §13); joined_at set; `MemberJoinedTeam` event; removal sets left_at (history preserved).
- **Tech tasks:** team-membership endpoints; member-of-multiple-teams support in queries; UI on team page.
- **Tests:** multi-team membership; remove preserves history; isolation.

#### E04-F2 — Feature: Recursive Hierarchy (Slice 2)

**E04-S4 — Child teams + full closure maintenance** · P1 · deps: E04-S1 · **2 d**
As a Tenant Admin or authorized Leader, I want to create child teams at any depth (A → A1 → A1.1 → …) so the organization can grow without limits.

- **AC:** no depth limit anywhere (dev rule 4); closure rows complete for all ancestor/descendant pairs; `GET /teams/:id/children|descendants|ancestors` correct at 6+ levels.
- **Tech tasks:** closure insert-subtree logic; hierarchy read endpoints; tree UI (lazy-loaded).
- **Tests:** hierarchy suite: invariants at depth 6; property-based random tree construction; performance sanity on 1k-team tree.

**E04-S5 — Team move with history** · P1 · deps: E04-S4 · **2 d**
As a Tenant Admin, I want to move a team (with its subtree) under a new parent so reorganizations are possible without losing history.

- **AC:** single-transaction closure rewire; cycle prevention (cannot move under own descendant); prior structure queryable point-in-time; `team.moved` audit + event; metrics rollups correct after move.
- **Tech tasks:** move endpoint + closure delete/reinsert algorithm; validation; move UI with confirmation.
- **Tests:** property-based move tests re-verifying invariants; cycle rejection; rollup re-check after move (with E09-S3).

**E04-S6 — Scoped team permissions** · P1 · deps: E04-S4, E01-S3 · **2.5 d**
As a Leader, I want my permissions scoped (`SELF / DIRECT_TEAM / DESCENDANT_TEAMS / SPECIFIC_TEAMS / TENANT_ALL`) so I see exactly my authorized organization — no more.

- **AC:** parent leader views authorized descendants; child leader cannot view unauthorized ancestors/siblings (spec §73); scope checks use closure table; Tenant Admin has TENANT_ALL.
- **Tech tasks:** scope model on role-permission grants; scope-resolution service (closure-backed); guard integration; scope admin UI.
- **Tests:** full scope matrix per `17-test-strategy.md` §7; Slice 2 E2E asserts visibility per login.

**E04-S7 — Team archive** · P1 · deps: E04-S4 · **0.5 d**
As a Tenant Admin, I want to archive a team (never destroy) so history remains intact (spec §16).

- **AC:** archived teams hidden from active views, present in history; archiving a team with active children requires explicit cascade choice; audited.
- **Tech tasks:** status transition + validation; UI.
- **Tests:** history queries include archived; active listings exclude.

---

### E05 — Epic: Goals & Dreams (MVP module 9)

**E05-S1 — Member creates goal** · P0 · deps: E03-S4 · **1.5 d**
As a Member, I want to create a goal (title, category, target date, description) and update its progress so my journey has direction.

- **AC:** goal CRUD scoped to the owning member; progress 0–100 with status (active/completed/abandoned); `GoalCreated`/`GoalCompleted` events; goals visible on my dashboard.
- **Tech tasks:** goal entity; endpoints; web goal UI (create, list, progress slider).
- **Tests:** owner-only access (another member 404); events on create/complete; E2E in Slice 1.

**E05-S2 — Dreams & vision list** · P1 · deps: E05-S1 · **1 d**
As a Member, I want a personal dreams list (100 Dreams style, categories: life/family/financial/travel/health/learning/business) so goals connect to meaning (spec §22 subset).

- **AC:** dreams CRUD, private by default; a dream can link to goals; categories are config data, not code.
- **Tech tasks:** dream entity + link table; UI list/board.
- **Tests:** privacy default; link integrity; isolation.

---

### E06 — Epic: Learning (MVP module 10)

**E06-S1 — Course & lesson management** · P0 · deps: E02-S3 · **1.5 d**
As a Tenant Admin, I want to create a course with ordered lessons (video URL / text / task) so members can learn.

- **AC:** course + lessons CRUD tenant-scoped; lesson types: content, task; draft/published status; media references stored as R2 keys or external URLs.
- **Tech tasks:** course/lesson entities; endpoints; admin authoring UI (minimal).
- **Tests:** isolation; publish gating (draft invisible to members); contract tests.

**E06-S2 — Member starts course & completes tasks** · P0 · deps: E06-S1, E03-S4 · **1.5 d**
As a Member, I want to start a course, work through lessons, and complete tasks so my learning progresses (Slice 1 requirement).

- **AC:** enrollment gated by `course.access` entitlement; LearningProgress per member/lesson; `CourseStarted` and task/lesson completion events; progress % on dashboard.
- **Tech tasks:** enrollment + progress entities; endpoints; web course player (list → lesson → complete).
- **Tests:** entitlement gate flips with plan mapping; progress math unit-tested; E2E in Slice 1 journey.

**E06-S3 — Learning assignment** · P1 · deps: E06-S2, E04-S4 · **1 d**
As a Tenant Admin or Leader, I want to assign a course to a team or member so learning journeys are directed (spec §24 subset).

- **AC:** assignment by team (current members) or individual; assignees notified; leader sees team completion status within scope.
- **Tech tasks:** assignment entity + fan-out job (worker); notification hook; team learning view.
- **Tests:** scope: leader assigns only within authorized teams; fan-out idempotent.

---

### E07 — Epic: Basic CRM (MVP module 11)

**E07-S1 — Leads & configurable pipeline** · P1 · deps: E03-S4 · **2 d**
As a Member, I want to record leads and move them through my tenant's configurable pipeline stages so I can develop customers (spec §34).

- **AC:** lead CRUD owned by the member (leader visibility only via scope grants); pipeline stages are tenant config, not code (dev rule 12); stage history kept.
- **Tech tasks:** lead entity + stage-config entity; endpoints; kanban-ish mobile-first UI.
- **Tests:** stage config swap without code change; owner/scope visibility matrix; isolation.

**E07-S2 — Follow-ups & interactions** · P1 · deps: E07-S1 · **1.5 d**
As a Member, I want follow-up tasks with due dates and an interaction log per lead so nothing slips.

- **AC:** follow-ups with due date/status; overdue surfaced on dashboard; interactions (note/call/message) timeline per lead; `lead.converted` recorded when a lead becomes a customer/member.
- **Tech tasks:** follow_up + interaction entities; endpoints; timeline UI; dashboard hook.
- **Tests:** overdue query correctness (timestamptz edges); conversion event; isolation.

**E07-S3 — Customer records & conversion** · P1 · deps: E07-S2 · **1 d**
As a Member, I want to convert a lead to a customer (optionally linked to a member registration) so my customer base is tracked.

- **AC:** conversion preserves lead history; `CustomerConverted` event; customer list with tags/segments (basic).
- **Tech tasks:** customer entity + conversion endpoint; tag support; UI.
- **Tests:** conversion idempotency; history intact; isolation.

---

### E08 — Epic: Notifications (MVP module 12)

**E08-S1 — Transactional email via worker** · P0 · deps: E00-S6, E00-S8 · **1.5 d**
As the platform, I want templated transactional email (invites, welcome) sent through the BullMQ worker so requests stay fast and sends are retryable.

- **AC:** email jobs enqueued (never sent inline); retries with backoff + DLQ; templates support th/en and tenant branding; provider behind an interface (fake in tests).
- **Tech tasks:** notification module + email adapter; template renderer; worker consumer; outbox→notification wiring for invite events.
- **Tests:** dispatch via fake transport; retry/DLQ behavior; locale template selection.

**E08-S2 — In-app notification center** · P1 · deps: E08-S1 · **1.5 d**
As a Member, I want an in-app notification feed (assignment, team changes, goal milestones) with read state so I stay informed.

- **AC:** notifications persisted per member; unread badge; mark read/all; generated from domain events via worker.
- **Tech tasks:** notification entity + endpoints; web bell/feed component; event→notification mapping table.
- **Tests:** event-to-notification fan-out; read-state; isolation.

**E08-S3 — Notification preferences** · P2 · deps: E08-S2 · **1 d**
As a Member, I want per-channel preferences (in-app, email; LINE later) so I control what reaches me (spec §52).

- **AC:** preference matrix per category×channel; respected by the worker at send time; sensible defaults.
- **Tech tasks:** preference entity + endpoints; worker gate; settings UI.
- **Tests:** suppressed channel not sent (fake transport); defaults applied.

---

### E09 — Epic: Dashboard & Analytics (MVP module 13)

**E09-S1 — Personal member dashboard** · P0 · deps: E05-S1, E06-S2 · **1.5 d**
As a Member, I want a dashboard showing my goals, learning progress, tasks, and recent activity so I see my journey at a glance (Slice 1 end state).

- **AC:** dashboard reflects goal/course/task completion within one request cycle of the action ("Dashboard Updates" in §72); mobile-first; th/en.
- **Tech tasks:** `GET /me/dashboard` read model; web dashboard page (cards); empty states.
- **Tests:** E2E: complete task → dashboard reflects it; read model correctness; isolation.

**E09-S2 — Team dashboard (direct metrics)** · P1 · deps: E04-S3, E09-S1 · **1 d**
As a Leader, I want my team's dashboard (direct members, active members, new members, learning progress, goals) so I can lead with facts.

- **AC:** direct metrics only from direct TeamMemberships; visible only within permission scope; drill-down to member list.
- **Tech tasks:** `GET /teams/:id/dashboard` read model; web team dashboard.
- **Tests:** metric correctness against fixture tree; scope enforcement.

**E09-S3 — Organization metrics rollup** · P1 · deps: E09-S2, E04-S4 · **2 d**
As a Senior Leader, I want organization metrics (`organization_members`, `organization_sales`-ready structure, learning rollups) computed over descendants via the closure table, separated from direct metrics (spec §20).

- **AC:** direct vs organization clearly separated in API and UI; rollups correct at every node of a 4-level fixture tree; correct after a team move; performant (single closure join, no N+1).
- **Tech tasks:** rollup queries (closure-backed); caching with invalidation on membership/team events; UI toggle direct/organization.
- **Tests:** hierarchy metrics suite (known-value fixtures); post-move re-verification; query performance sanity.

**E09-S4 — Tenant admin dashboard** · P2 · deps: E09-S3 · **1 d**
As a Tenant Admin, I want tenant-wide KPIs (members, active members, new members, learning completion, teams) so I can steer the organization.

- **AC:** tenant-wide aggregates; TENANT_ALL scope required; trends over time (daily snapshots).
- **Tech tasks:** snapshot job (worker, daily); tenant dashboard endpoint + UI.
- **Tests:** snapshot idempotency; access limited to admin roles.

---

### E10 — Epic: Basic AI Assistant (MVP module 15)

**E10-S1 — AI Gateway + provider adapter** · P1 · deps: E00-S6 · **2 d**
As the platform, I want all AI calls to flow through a provider-agnostic gateway that assembles authorized context and meters usage (ADR-009).

- **AC:** `Application → Gateway → Router → Adapter` in place; context = tenant + member + scope + entitlements only; every call writes `ai_usage` (tenant_id, tokens, cost); fake adapter for tests; no provider SDK imported outside the gateway (lint-enforced).
- **Tech tasks:** gateway module + adapter interface; one real adapter (Anthropic) + fake; usage metering; model router (config-driven).
- **Tests:** AI permission suite §12 foundations: context assembly asserted; usage rows written; lint boundary test.

**E10-S2 — Member AI assistant (chat)** · P1 · deps: E10-S1, E09-S1 · **2 d**
As a Member with the `ai.coach` entitlement, I want a chat assistant that knows my goals and learning (and nothing beyond my scope) so I get relevant guidance.

- **AC:** assistant answers about my goals/courses/tasks using only authorized data; entitlement-gated; conversations persisted per member (`ai_conversation`); health/medical guardrail disclaimer (spec §27).
- **Tech tasks:** context builder (member-scoped read models); chat endpoints (streamed); web chat UI; conversation storage.
- **Tests:** AI permission tests: out-of-scope/team/tenant data never enters context (asserted structurally); entitlement gate; conversation isolation.

**E10-S3 — AI daily quota caps per tenant** · P1 · deps: E10-S1 · **1 d**
As the platform operator, I want per-tenant (and per-member) daily AI quotas enforced at the gateway so costs cannot run away (cost guardrails).

- **AC:** quota from entitlement value (`ai.quota.daily`); exceeding → friendly 429 with reset time; platform kill-switch; usage visible per tenant on platform dashboard.
- **Tech tasks:** quota counter (Redis, UTC-day window); gateway enforcement; platform usage endpoint.
- **Tests:** cap boundary tests; window rollover (timestamptz/UTC); kill-switch.

---

### E11 — Epic: Audit (MVP module 16)

**E11-S1 — Audit log pipeline** · P0 · deps: E00-S6 · **1.5 d**
As the platform, I want every sensitive mutation audited (`tenant, user, member, action, entity, before, after, timestamp, ip, device, request_id`) so accountability is structural (spec §60).

- **AC:** audit rows written for membership, team, leadership, role/permission, tenant-config, and auth-sensitive changes; before/after diffs captured; append-only (no update/delete path in app role).
- **Tech tasks:** audit interceptor/decorator (`@Audited(entity)`); diff capture; audit table hardening (RLS + no UPDATE grant).
- **Tests:** each Slice-1 sensitive action produces exactly one audit row (asserted in integration suites); append-only enforced.

**E11-S2 — Audit viewer** · P1 · deps: E11-S1 · **1 d**
As a Tenant Admin, I want to search my tenant's audit trail (by actor, entity, action, date) so I can investigate changes.

- **AC:** filterable, paginated viewer; tenant-scoped; platform admins have a platform-level view; export CSV (P2 polish).
- **Tech tasks:** audit query endpoints + indexes; admin UI page.
- **Tests:** isolation (alpha admin never sees beta audit rows); filter correctness.

---

### E12 — Epic: Knowledge → Product Journey (Slice 3)

#### E12-F1 — Feature: Knowledge Entities

**E12-S1 — Knowledge base entities & relations** · P1 · deps: E00-S6 · **2 d**
As a Tenant Admin (or platform, for global knowledge), I want `HealthGoal, Topic, Article, Ingredient, Brand, Product` with their relations (goal↔topic, topic↔ingredient, article↔topic/ingredient/product, ingredient↔product) so the knowledge graph exists (spec §28–§29 subset).

- **AC:** all six entities + relation tables; knowledge tier per record: global / tenant (private tier is Phase 2); tenant records RLS-protected, global records read-only to tenants.
- **Tech tasks:** schema + migrations; CRUD endpoints (admin); relation management UI (minimal); global-knowledge seeding path in seed script.
- **Tests:** relation integrity; global vs tenant visibility; isolation on tenant knowledge.

**E12-S2 — Product Intelligence (brand-neutral)** · P1 · deps: E12-S1 · **1.5 d**
As a Tenant Admin, I want products to carry brand, ingredients, health-goal mappings, evidence context, safety notes, source URL, and last-verified date — for any number of brands (spec §30–§31).

- **AC:** adding Brand B requires zero schema change (test-proven); product detail renders intelligence fields; safety notes always displayed with health context.
- **Tech tasks:** product fields per spec §30; product detail UI; second-brand fixture.
- **Tests:** brand-neutrality test (two brands, same schema); safety-note render assertion.

#### E12-F2 — Feature: The Journey

**E12-S3 — Goal → Topic → Article → Ingredient → Product navigation** · P1 · deps: E12-S2 · **2 d**
As a Member, I want to start from a healthy-living goal (e.g. Better Sleep) and navigate topic → article → ingredient → related products so knowledge leads and product follows (spec §74).

- **AC:** the full navigation works in the UI with the Better Sleep → Sleep Hygiene → article → Magnesium → products example seeded; product is never the entry point of the journey; related-content blocks on each level.
- **Tech tasks:** journey read endpoints; web journey pages (mobile-first); demo dataset in seed.
- **Tests:** Slice 3 E2E journey; link traversal integration tests.

**E12-S4 — Knowledge-first search** · P1 · deps: E12-S3 · **1.5 d**
As a Member, I want search that ranks knowledge (goals, topics, articles) above products so trust precedes selling (spec §33).

- **AC:** single search endpoint over knowledge + products; knowledge results always grouped/ranked before product results (contract-tested); tenant + global corpus only.
- **Tech tasks:** Postgres FTS (tsvector) over entities; ranking with type boost; search UI.
- **Tests:** ranking contract test; isolation (no cross-tenant hits); th/en tokenization sanity.

---

### E13 — Epic: MVP Polish (P2)

**E13-S1 — i18n completeness (th/en)** · P2 · deps: all UI stories · **1.5 d**
No hard-coded UI text (spec §54): all strings in next-intl catalogs; th and en complete; locale persisted per user; date/number formatting localized.

- **Tests:** lint/scan for raw strings in JSX; E2E locale smoke.

**E13-S2 — PWA & offline shell** · P2 · deps: E09-S1 · **1 d**
Installable PWA: manifest, icons, service worker with offline shell for dashboard; add-to-home-screen path verified on mobile.

- **Tests:** Lighthouse PWA checks in CI (budget).

**E13-S3 — Accessibility pass** · P2 · deps: all UI stories · **1.5 d**
WCAG 2.1 AA on core flows (dev rule 17): keyboard navigation, focus management, contrast, aria on interactive components.

- **Tests:** axe-core automated checks in Playwright on the three slice journeys.

**E13-S4 — Mobile UX polish** · P2 · deps: all UI stories · **1.5 d**
Mobile-first review of every MVP screen (dev rule 16): touch targets, layout at 360px, bottom-nav shell, form ergonomics.

- **Tests:** Playwright mobile-viewport suite green on slice journeys.

**E13-S5 — Observability dashboards & alerts** · P2 · deps: E00-S7 · **1.5 d**
Spec §68: error-tracking wired (Sentry or equivalent); queue depth/failed-job alerts; AI usage/cost dashboard; uptime checks on /healthz /readyz; billing budget alerts confirmed on all providers.

- **Tests:** synthetic error appears in tracker; alert fires on DLQ threshold (staged).

**E13-S6 — Custom roles UI** · P2 · deps: E01-S3 · **1 d**
Tenant Admin can create custom roles from the permission catalog (spec §57) — data model existed since E01-S3; this ships the UI.

- **Tests:** custom role grants behave identically to seeded roles in the permission matrix.

**E13-S7 — Rate limiting & security headers** · P2 · deps: E00-S7 · **1 d**
Per-route rate limits (auth, AI, email); security headers (CSP, HSTS, nosniff, frame-ancestors) on web; CORS locked to known origins.

- **Tests:** 429 behavior; securityheaders-style assertion in E2E.

**E13-S8 — Data export & tenant offboarding basics** · P2 · deps: E02-S1 · **1 d**
Platform admin can export a tenant's data (JSON + object manifest) before any deactivation; tenant deactivation is reversible (status), never destructive.

- **Tests:** export completeness against fixtures; deactivated tenant blocks logins but preserves data.

---

## Future — Phase 2+ Headline Epics (detailed when their phase begins)

**EF-1 — Phase 2: Journey Depth** · Healthy Living OS (habits, wellness score, health-data permissions §59) · Knowledge Graph completion + evidence · Community OS (feed, groups, team communities) · Challenges & Gamification · Commerce + Subscription engine · AI Search (RAG, authorization-before-retrieval) · AI CRM · Content recommendation. _(Exit criteria in `16-development-roadmap.md` §3.)_

**EF-2 — Phase 3: Growth Economics** · Rank Engine · Compensation Rule Engine (optional per tenant, config-only plans) · Reward Engine · Referral Graph (decoupled — ADR-006) · Leadership journey · Advanced Automation (trigger-action) · AI Team Coach + Leadership Coach · Advanced analytics. _(Exit criteria in roadmap §4.)_

**EF-3 — Phase 4: Enterprise & Ecosystem** · Multi-brand marketplace · Corporate wellness · Partner portal · API marketplace + webhooks · Enterprise SSO · Dedicated tenant database migration (ADR-002 path) · White-label mobile · Advanced AI agents. _(Exit criteria in roadmap §5.)_

**EF-4 — Platform Operations at Scale** · Tenant usage metering & billing automation · Platform dashboard (MRR/ARR/churn/AI cost) · SLA/observability maturity · Restore drills automation.

---

## Priority Summary

| Band       | Stories | Ideal days | Delivers                                                                                                                                         |
| ---------- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0**     | 28      | ~39.5 d    | Sprint 0 foundation + Vertical Slice 1 (spec §72) end-to-end                                                                                     |
| **P1**     | 21      | ~32 d      | Slice 2 (recursive teams + scopes) · Slice 3 (knowledge journey) · CRM · notifications · AI assistant · rollups · audit viewer · tenant switcher |
| **P2**     | 10      | ~12 d      | i18n, PWA, a11y, mobile, observability, custom roles, hardening, offboarding, preferences, tenant dashboard                                      |
| **Future** | 4 epics | —          | Phase 2–4 headlines                                                                                                                              |

Dependency spine (critical path): `E00-S1 → S2 → S4 → S5 → S6` → `E01-S1..S3` → `E02-S1..S3` → `E03-S1..S4` → `E04-S1..S3` → `E05-S1 / E06-S1..S2` → `E09-S1` → Slice 1 E2E.
