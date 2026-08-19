# 14 — MVP Scope

> Do NOT attempt to build the full platform immediately (spec §70). The MVP proves one chain end-to-end:
>
> ```text
> Tenant → Membership → Member → Team → Goal → Learning → CRM → Dashboard
> ```
>
> Status: Approved · Last updated: 2026-08-19 · Source: spec §70–§71, §84

---

## 1. MVP Modules — IN Scope (spec §71)

The 16 MVP modules, mapped to the canonical NestJS modules (`identity`, `tenant`, `membership`, `team`, `goal`, `learning`, `crm`, `notification`, `analytics`, `ai`, `audit`, `platform`):

| #   | MVP module (spec)  | NestJS module           | MVP contents                                                                                                                                                                |
| --- | ------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Authentication     | `identity`              | Email+password register/login (Argon2id), JWT access 15 min + refresh rotation, HttpOnly cookies, logout, password reset                                                    |
| 2   | Tenant             | `tenant`                | Tenant entity, TenantContext resolution (subdomain → custom domain → `X-Tenant-ID` → JWT claim) via AsyncLocalStorage (nestjs-cls), settings, feature flags, basic branding |
| 3   | Tenant Switcher    | `identity` + `apps/web` | One User ↔ many tenants via TenantMembership; UI switcher; per-tenant session context                                                                                       |
| 4   | Membership         | `membership`            | MembershipPlan CRUD (tenant admin), Membership activation (free/manual — no payments), Entitlement model + enforcement (`course.access`, `ai.coach`, `team.create`, …)      |
| 5   | Member Profile     | `identity`              | Member + MemberProfile, tenant custom fields, Member 360 view (populated by MVP domains only)                                                                               |
| 6   | Role & Permission  | `identity`              | RBAC, dot-notation permission keys, scopes `SELF / DIRECT_TEAM / DESCENDANT_TEAMS / SPECIFIC_TEAMS / TENANT_ALL`, default + custom tenant roles                             |
| 7   | Team Hierarchy     | `team`                  | Team (`parent_team_id`), TeamClosure, unlimited depth, create/move/archive, TeamMembership (multi-team), hierarchy queries                                                  |
| 8   | Team Leadership    | `team`                  | TeamLeadership with `effective_from`/`effective_to`, `is_primary`, leader change with preserved history                                                                     |
| 9   | Goals / Dreams     | `goal`                  | Goal + Dream CRUD, categories, milestones, basic tasks, progress                                                                                                            |
| 10  | Learning           | `learning`              | Course, Lesson, LearningProgress, assignment to member/team, completion tracking                                                                                            |
| 11  | Basic CRM          | `crm`                   | Lead, Customer, configurable PipelineStage, FollowUp, Interaction notes                                                                                                     |
| 12  | Notifications      | `notification`          | In-app + email, event-driven (welcome, goal completed, course assigned, follow-up due), per-member basic preferences                                                        |
| 13  | Dashboard          | `analytics`             | Member dashboard (goals, learning), Team dashboard (direct vs organization member counts, learning progress), drill-down for leaders                                        |
| 14  | Admin              | `platform` + `tenant`   | Platform admin: create/configure tenants, create tenant owner, platform dashboard (tenant counts). Tenant admin: plans, members, teams, roles, lifecycle/onboarding config  |
| 15  | Basic AI Assistant | `ai`                    | AI Gateway (provider-agnostic, Anthropic adapter first), one member-facing assistant with permission-aware context, AIConversation + AIUsage tracking                       |
| 16  | Audit              | `audit`                 | AuditLog (tenant, user, member, action, entity, before/after, timestamp, ip, device, request_id) for all sensitive operations                                               |

Also in MVP (cross-cutting foundations required by the above):

- **Event backbone**: outbox table + BullMQ/Redis, PascalCase domain events (`TenantCreated`, `MemberRegistered`, `MembershipActivated`, `TeamCreated`, `LeaderAssigned`, `MemberJoinedTeam`, `GoalCreated`, `GoalCompleted`, `CourseStarted`, `CourseCompleted`, `CustomerConverted`).
- **Lifecycle/onboarding config** per [06-member-lifecycle.md](./06-member-lifecycle.md) (MVP subset).
- **Slice-3 knowledge read path**: HealthGoal, Topic, Article, Ingredient, Brand, Product (read-only, brand-neutral) — see [15-mvp-user-journey.md](./15-mvp-user-journey.md).
- **i18n** th/en (next-intl) — no hard-coded UI text.
- **Mobile-first PWA** responsive UX.
- **Tenant isolation**: `tenant_id` on every tenant-owned table, composite indexes starting with `tenant_id`, Postgres RLS via `app.tenant_id`, R2 paths `/tenants/{tenant_id}/...`.
- **REST `/api/v1`** with cursor pagination and error envelope `{error:{code,message,details,request_id}}`.

## 2. Explicitly OUT of Scope (spec §71 "Do NOT initially build")

| Excluded                 | Meaning for MVP                                                                                                                 | Arrives                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Advanced Commerce**    | No cart, checkout, payments, pricing engine, coupons, orders. Only the read-only brand-neutral catalog needed by Slice 3.       | Phase 2                               |
| **Compensation**         | No compensation plans, rules, commissions, volumes, legs, payouts. Schema reserves nothing beyond the separate-graph principle. | Phase 3                               |
| **Wearable Integration** | No device sync, no step/sleep imports.                                                                                          | Phase 4                               |
| **Advanced Health**      | No health tracking, wellness scores, or AI health coach. Only `HealthGoal` as a knowledge anchor.                               | Phase 2                               |
| **Marketplace**          | No multi-brand marketplace, no seller flows.                                                                                    | Phase 4                               |
| **Microservices**        | Modular monolith only; no service extraction, no inter-service RPC.                                                             | When measurably needed                |
| **Complex Automation**   | No user-facing workflow builder. Event backbone + direct notification handlers only.                                            | Phase 2 (recipes) / Phase 3 (builder) |
| **Native Mobile App**    | PWA only; no iOS/Android binaries, no push via APNs/FCM (in-app + email notifications only).                                    | Phase 4                               |

Additional non-goals for MVP (implied by spec):

- No community/feed/challenges/gamification (Phase 2).
- No rank engine or rewards engine (Phase 3).
- No referral-graph features beyond the reserved, decoupled schema (Phase 3).
- No MFA, social login, or SSO (Phase 2/4). No LINE/SMS/WhatsApp channels (Phase 2+).
- No tenant billing/SaaS payments (Phase 2).

## 3. Definition of MVP Done — Acceptance Checklist (spec §84, verbatim)

MVP is complete when every box checks:

- [ ] Platform Admin can create multiple tenants.
- [ ] Tenant data is isolated.
- [ ] One user can belong to multiple tenants.
- [ ] Tenant can create membership plans.
- [ ] Tenant can invite members.
- [ ] Tenant can create unlimited nested teams.
- [ ] Members can belong to multiple teams.
- [ ] Teams can have independent leaders.
- [ ] Leaders can manage authorized descendant teams.
- [ ] Team hierarchy history is preserved.
- [ ] Member can create goals.
- [ ] Member can follow learning journey.
- [ ] CRM supports leads and follow-up.
- [ ] Dashboard shows personal and team progress.
- [ ] Roles and permissions work.
- [ ] AI respects tenant and team permissions.
- [ ] Audit logs work.
- [ ] Mobile UX is usable.
- [ ] Automated tenant-isolation tests pass.

Each item maps to at least one automated test in `17-test-strategy.md`; the highest-priority test remains: **Tenant A must never access Tenant B data** (spec §69).

## 4. MVP Guardrails

Rules that keep the MVP fast **and** the architecture correct (spec §78, final instruction):

1. **Never hard-code** a tenant, company name, brand-specific logic, team depth, rank structure, membership structure, or compensation plan. All business rules are configuration.
2. **Never couple graphs**: Team Graph ≠ Referral Graph ≠ Compensation Graph ≠ Mentor Graph — separate tables even where only one ships in MVP.
3. **Every tenant-owned record is tenant-aware**; every sensitive API enforces tenant + permission scope; RLS is on from the first migration, not retrofitted.
4. **Gate by entitlement/permission, never by name** — no `if (plan === 'VIP')`, no `if (stage === 'partner')`.
5. **Domain events from day 1** — even MVP-internal reactions (notifications, dashboards, audit) go through the outbox, so Phase 3 automation consumes the same stream.
6. **Preserve history** — effective dates and audit events instead of destructive updates; never permanently destroy organization history.
7. **Modular monolith discipline** — modules expose service interfaces; no cross-module table access; modules must be extractable later.
8. **AI isolation** — only the AI Gateway touches providers; context assembly enforces authorization **before** retrieval; AIUsage tracked per tenant from the first call.
9. **Simplicity before scale** — no premature caching layers, no CQRS, no event sourcing, no microservices; optimize when measured.
10. **Mobile-first, accessible, i18n-clean** — th/en message catalogs from the first screen; no literal UI strings.
11. **Stop-and-verify cadence** (spec §83): after each major milestone (schema, tenant+identity, membership, team, journey, learning+CRM, dashboard, AI lite), verify consistency against docs before expanding.
12. **Scope changes require doc changes** — anything moving into or out of this scope must update this file and `16-development-roadmap.md` first.

## 5. MVP Proof Path

The MVP is validated by the three vertical slices in [15-mvp-user-journey.md](./15-mvp-user-journey.md):

1. **Slice 1** — platform admin → tenant → plan → tenant admin → team → member registration → goal → course → dashboard (spec §72).
2. **Slice 2** — recursive teams 4 levels deep with permission assertions and metric roll-up (spec §73).
3. **Slice 3** — knowledge-to-product journey, brand-neutral (spec §74).

Implementation begins only from the first approved vertical slice.
