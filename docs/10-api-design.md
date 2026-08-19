# 10 — API Design

> **Project:** AVIORA — Multi-Tenant Membership, Healthy Living & Growth Operating System
> **Status:** Approved for MVP · **Last updated:** 2026-08-19
> **Spec references:** §6 (tenant resolution), §19 (scopes), §67 (API design), §68 (observability)

---

## 1. Principles

- **REST first** (spec §67). GraphQL/other styles only if a measurable need appears.
- **Base path:** `/api/v1` — all endpoints below are relative to it.
- Every request resolves **tenant → user → permission → scope → entitlement** before any handler logic runs.
- Backend: NestJS 11 + TypeScript. IDs are **uuid v7**. All timestamps are ISO-8601 with offset (`timestamptz` in DB). DB columns are snake_case; JSON payloads are `snake_case` too, matching the DB and audit records 1:1.
- i18n: `Accept-Language: th | en` selects localized strings in responses; defaults to the tenant's `default_language`.
- Mutations emit domain events (PascalCase, e.g. `MemberRegistered`) via the `domain_events` outbox + BullMQ — never synchronously side-effect other modules.

### Resource conventions

| Convention        | Rule                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Naming            | Plural kebab-case nouns: `/membership-plans`, `/audit-logs`                                                                                              |
| Identity          | Path ids are uuid v7: `/teams/018f6f3a-...`                                                                                                              |
| Create            | `POST /resources` → `201 Created` + `Location` header                                                                                                    |
| Read              | `GET /resources` (list, paginated), `GET /resources/:id`                                                                                                 |
| Update            | `PATCH /resources/:id` (partial, JSON merge semantics) → `200`                                                                                           |
| Delete            | Soft-archive via `POST /resources/:id/archive` where history matters (teams, plans); hard `DELETE` only for truly disposable records (draft invitations) |
| State transitions | Verb sub-resources: `POST /goals/:id/complete`, `POST /crm/leads/:id/convert`                                                                            |
| Sub-resources     | Nesting max 2 levels: `/teams/:id/members` ✅, deeper → top-level with filters                                                                           |
| Filtering         | Query params: `?status=active&team_id=...`; full-text via `?q=`                                                                                          |
| Sorting           | `?sort=-created_at,name` (leading `-` = descending)                                                                                                      |
| Field selection   | `?fields=id,name,status` (optional optimization)                                                                                                         |

---

## 2. Tenant Resolution

Order of precedence (first match wins); the resolved tenant is placed into `TenantContext`
(nestjs-cls / AsyncLocalStorage) and into the Postgres session var `app.tenant_id` for RLS:

| #   | Mechanism            | Example                                                                 | Used by                      |
| --- | -------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| 1   | Platform subdomain   | `acme.aviora.app`                                                       | Web app default              |
| 2   | Custom domain        | `members.acmewellness.com` (verified, mapped in `tenant.custom_domain`) | White-label tenants          |
| 3   | `X-Tenant-ID` header | `X-Tenant-ID: 018f6f3a-…`                                               | Internal/API clients, mobile |
| 4   | JWT tenant claim     | `tid` claim from the access token                                       | Fallback / consistency check |

Rules:

- If both a domain-derived tenant and an `X-Tenant-ID`/`tid` are present, they **must match**, else `403 TENANT_MISMATCH`.
- The JWT `tid` must correspond to an **active** `TenantMembership` of the user; a user switches tenants by re-issuing tokens via `POST /auth/tenant-switch`.
- Platform endpoints (`/platform/*`) run without tenant context and require platform roles.
- Unresolvable tenant → `404 TENANT_NOT_FOUND` (never leak existence via 403).

---

## 3. Authentication Endpoints

Access token: JWT, 15 min TTL. Refresh token: opaque, rotated on every use, stored in an
`HttpOnly; Secure; SameSite=Lax` cookie. See [13-security-architecture.md](./13-security-architecture.md).

| #   | Method & path                   | Purpose                                                   | Auth                  |
| --- | ------------------------------- | --------------------------------------------------------- | --------------------- |
| 1   | `POST /auth/register`           | Register a User (+ Member when invitation context exists) | Public                |
| 2   | `POST /auth/login`              | Email + password → access token + refresh cookie          | Public                |
| 3   | `POST /auth/refresh`            | Rotate refresh token, new access token                    | Refresh cookie        |
| 4   | `POST /auth/logout`             | Revoke current session (Redis denylist)                   | Bearer                |
| 5   | `POST /auth/logout-all`         | Revoke all sessions of the user                           | Bearer                |
| 6   | `GET /auth/me`                  | Current user + tenant memberships (tenant switcher data)  | Bearer                |
| 7   | `POST /auth/tenant-switch`      | Issue tokens scoped to another tenant membership          | Bearer                |
| 8   | `POST /auth/invitations/accept` | Accept invitation token → create/link Member              | Public (invite token) |
| 9   | `POST /auth/password/forgot`    | Start password reset (email)                              | Public                |
| 10  | `POST /auth/password/reset`     | Complete password reset                                   | Public (reset token)  |

**Example — login**

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "pong@example.com", "password": "••••••••" }
```

```json
{
  "data": {
    "access_token": "eyJhbGciOiJFUzI1NiIs…",
    "token_type": "Bearer",
    "expires_in": 900,
    "user": {
      "id": "018f6f3a-9a7b-7c3d-8e4f-2b1a0c9d8e7f",
      "email": "pong@example.com",
      "default_tenant_id": "018f6f3a-1111-7abc-9def-000000000001"
    }
  }
}
```

(The refresh token is set only as a cookie: `Set-Cookie: aviora_rt=…; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`.)

---

## 4. MVP Endpoint Catalog

All endpoints require a Bearer token and resolved tenant context unless marked otherwise.
The **Permission** column names the guard key (scope evaluated per caller, doc 07).

### 4.1 Platform — tenant administration (`/platform`, platform roles only)

| #   | Method & path                         | Purpose                                               | Permission                 |
| --- | ------------------------------------- | ----------------------------------------------------- | -------------------------- |
| 11  | `GET /platform/tenants`               | List tenants (paginated)                              | `platform.tenant.view`     |
| 12  | `POST /platform/tenants`              | Create tenant (+ seed roles, root team, owner invite) | `platform.tenant.create`   |
| 13  | `GET /platform/tenants/:id`           | Tenant detail                                         | `platform.tenant.view`     |
| 14  | `PATCH /platform/tenants/:id`         | Update tenant (plan, domains, status)                 | `platform.tenant.update`   |
| 15  | `POST /platform/tenants/:id/suspend`  | Suspend tenant                                        | `platform.tenant.suspend`  |
| 16  | `POST /platform/tenants/:id/activate` | Re-activate tenant                                    | `platform.tenant.activate` |
| 17  | `GET /platform/dashboard`             | Platform metrics (tenants, MRR, ARR, AI cost)         | `platform.analytics.view`  |

### 4.2 Tenant configuration (`/tenant`)

| #   | Method & path                    | Purpose                                               | Permission               |
| --- | -------------------------------- | ----------------------------------------------------- | ------------------------ |
| 18  | `GET /tenant`                    | Current tenant profile (branding, settings, features) | `tenant.view`            |
| 19  | `PATCH /tenant`                  | Update profile/branding                               | `tenant.update`          |
| 20  | `GET /tenant/settings`           | Read settings & feature flags                         | `tenant.view`            |
| 21  | `PATCH /tenant/settings`         | Update settings & feature flags                       | `tenant.settings.manage` |
| 22  | `GET /tenant/roles`              | List roles (system + custom) with grants              | `tenant.role.view`       |
| 23  | `POST /tenant/roles`             | Create custom role                                    | `tenant.role.manage`     |
| 24  | `PATCH /tenant/roles/:id`        | Update role grants                                    | `tenant.role.manage`     |
| 25  | `POST /tenant/roles/:id/archive` | Archive custom role                                   | `tenant.role.manage`     |
| 26  | `GET /tenant/permissions`        | Permission key catalog (for role builder UI)          | `tenant.role.view`       |
| 27  | `GET /tenant/entitlements`       | Active entitlements of the tenant's plan              | `tenant.view`            |

### 4.3 Membership plans & memberships

| #   | Method & path                              | Purpose                                         | Permission                      |
| --- | ------------------------------------------ | ----------------------------------------------- | ------------------------------- |
| 28  | `GET /membership-plans`                    | List plans                                      | `membership.plan.view`          |
| 29  | `POST /membership-plans`                   | Create plan                                     | `membership.plan.manage`        |
| 30  | `GET /membership-plans/:id`                | Plan detail incl. entitlements                  | `membership.plan.view`          |
| 31  | `PATCH /membership-plans/:id`              | Update plan                                     | `membership.plan.manage`        |
| 32  | `POST /membership-plans/:id/archive`       | Archive plan (existing memberships unaffected)  | `membership.plan.manage`        |
| 33  | `PATCH /membership-plans/:id/entitlements` | Set plan → entitlement mapping                  | `membership.entitlement.manage` |
| 34  | `GET /memberships`                         | List memberships (filter by member/plan/status) | `membership.view`               |
| 35  | `POST /memberships`                        | Assign membership to member                     | `membership.assign`             |
| 36  | `GET /memberships/:id`                     | Membership detail                               | `membership.view`               |
| 37  | `POST /memberships/:id/cancel`             | Cancel membership                               | `membership.cancel`             |

### 4.4 Members

| #   | Method & path                               | Purpose                                              | Permission               |
| --- | ------------------------------------------- | ---------------------------------------------------- | ------------------------ |
| 38  | `GET /members`                              | List/search members (scope-filtered)                 | `member.view`            |
| 39  | `GET /members/me`                           | Caller's own Member 360 (profile, membership, teams) | intrinsic SELF           |
| 40  | `GET /members/:id`                          | Member profile (non-health fields)                   | `member.view`            |
| 41  | `PATCH /members/:id`                        | Update member profile / custom fields                | `member.update`          |
| 42  | `POST /members/:id/deactivate`              | Deactivate member                                    | `member.deactivate`      |
| 43  | `POST /members/:id/reactivate`              | Reactivate member                                    | `member.deactivate`      |
| 44  | `GET /members/:id/goals`                    | Member's goals                                       | `goal.view`              |
| 45  | `GET /members/:id/learning`                 | Member's learning progress                           | `learning.progress.view` |
| 46  | `GET /members/:id/teams`                    | Member's team memberships                            | `team.member.view`       |
| 47  | `GET /members/me/health-grants`             | List caller's health-data consent grants             | intrinsic SELF           |
| 48  | `POST /members/me/health-grants`            | Grant a named person health-data access              | intrinsic SELF           |
| 49  | `POST /members/me/health-grants/:id/revoke` | Revoke a grant (immediate)                           | intrinsic SELF           |

### 4.5 Invitations

| #   | Method & path                  | Purpose                                 | Permission      |
| --- | ------------------------------ | --------------------------------------- | --------------- |
| 50  | `GET /invitations`             | List invitations (status filter)        | `member.invite` |
| 51  | `POST /invitations`            | Invite member (email, role, team, plan) | `member.invite` |
| 52  | `GET /invitations/:id`         | Invitation detail                       | `member.invite` |
| 53  | `POST /invitations/:id/resend` | Resend invitation email                 | `member.invite` |
| 54  | `DELETE /invitations/:id`      | Revoke pending invitation               | `member.invite` |

### 4.6 Teams

| #   | Method & path                            | Purpose                                              | Permission            |
| --- | ---------------------------------------- | ---------------------------------------------------- | --------------------- |
| 55  | `GET /teams`                             | List teams visible to caller (scope-filtered tree)   | `team.view`           |
| 56  | `POST /teams`                            | Create team / child team (`parent_team_id` nullable) | `team.create`         |
| 57  | `GET /teams/:id`                         | Team detail (parent, depth, path)                    | `team.view`           |
| 58  | `PATCH /teams/:id`                       | Update team settings                                 | `team.update`         |
| 59  | `POST /teams/:id/move`                   | Re-parent team (closure table rebuild, audited)      | `team.move`           |
| 60  | `POST /teams/:id/archive`                | Archive team (history preserved)                     | `team.archive`        |
| 61  | `GET /teams/:id/children`                | Direct child teams                                   | `team.view`           |
| 62  | `GET /teams/:id/descendants`             | All descendants via closure table (`?max_depth=`)    | `team.view`           |
| 63  | `GET /teams/:id/members`                 | Direct members (`?include=descendants` for org view) | `team.member.view`    |
| 64  | `POST /teams/:id/members`                | Add member to team                                   | `team.member.manage`  |
| 65  | `PATCH /teams/:id/members/:member_id`    | Change team-membership role/status                   | `team.member.manage`  |
| 66  | `DELETE /teams/:id/members/:member_id`   | Remove member (sets `left_at`, keeps history)        | `team.member.manage`  |
| 67  | `GET /teams/:id/leaders`                 | Leadership assignments (effective-dated)             | `team.leader.view`    |
| 68  | `POST /teams/:id/leaders`                | Assign leader (audited, effective-dated)             | `team.leader.manage`  |
| 69  | `POST /teams/:id/leaders/:member_id/end` | End a leadership assignment                          | `team.leader.manage`  |
| 70  | `GET /teams/:id/dashboard`               | Team dashboard (direct vs organization metrics)      | `team.analytics.view` |

**Example — team dashboard**

```http
GET /api/v1/teams/018f7a10-2222-7abc-9def-00000000a001/dashboard
Authorization: Bearer eyJ…
X-Tenant-ID: 018f6f3a-1111-7abc-9def-000000000001
```

```json
{
  "data": {
    "team_id": "018f7a10-2222-7abc-9def-00000000a001",
    "name": "Team Alpha",
    "primary_leader": { "member_id": "018f7a10-…", "display_name": "Pong" },
    "direct": {
      "members": 24,
      "active_members": 19,
      "new_members_30d": 3,
      "leads": 41,
      "customers": 12,
      "learning_completion_rate": 0.62
    },
    "organization": {
      "members": 183,
      "active_members": 141,
      "new_members_30d": 17,
      "leads": 310,
      "customers": 96,
      "learning_completion_rate": 0.55,
      "child_teams": 4,
      "descendant_teams": 11
    },
    "goals": { "active": 5, "completed_this_quarter": 2 },
    "as_of": "2026-08-19T09:00:00+07:00"
  }
}
```

### 4.7 Goals & Dreams

| #   | Method & path              | Purpose                                           | Permission                         |
| --- | -------------------------- | ------------------------------------------------- | ---------------------------------- |
| 71  | `GET /goals`               | List goals (own by default; team via `?team_id=`) | `goal.view`                        |
| 72  | `POST /goals`              | Create goal (personal or team)                    | `goal.manage` / `team.goal.manage` |
| 73  | `GET /goals/:id`           | Goal detail with milestones                       | `goal.view`                        |
| 74  | `PATCH /goals/:id`         | Update goal                                       | `goal.manage`                      |
| 75  | `POST /goals/:id/complete` | Complete goal (emits `GoalCompleted`)             | `goal.manage`                      |
| 76  | `POST /goals/:id/archive`  | Archive goal                                      | `goal.manage`                      |
| 77  | `GET /dreams`              | List caller's dreams / vision board               | `goal.dream.view`                  |
| 78  | `POST /dreams`             | Create dream                                      | `goal.dream.manage`                |
| 79  | `PATCH /dreams/:id`        | Update dream                                      | `goal.dream.manage`                |
| 80  | `DELETE /dreams/:id`       | Delete dream                                      | `goal.dream.manage`                |

### 4.8 Learning

| #   | Method & path                | Purpose                                          | Permission                |
| --- | ---------------------------- | ------------------------------------------------ | ------------------------- |
| 81  | `GET /courses`               | List published courses (creators see own drafts) | `learning.course.view`    |
| 82  | `POST /courses`              | Create course                                    | `learning.course.manage`  |
| 83  | `GET /courses/:id`           | Course detail with lesson outline                | `learning.course.view`    |
| 84  | `PATCH /courses/:id`         | Update course                                    | `learning.course.manage`  |
| 85  | `POST /courses/:id/publish`  | Publish course                                   | `learning.course.publish` |
| 86  | `GET /courses/:id/lessons`   | Lessons of a course                              | `learning.course.view`    |
| 87  | `POST /courses/:id/lessons`  | Add lesson                                       | `learning.course.manage`  |
| 88  | `PATCH /lessons/:id`         | Update lesson                                    | `learning.course.manage`  |
| 89  | `DELETE /lessons/:id`        | Remove lesson (draft courses only)               | `learning.course.manage`  |
| 90  | `POST /courses/:id/enroll`   | Enroll self (entitlement `course.access`)        | `learning.course.view`    |
| 91  | `POST /lessons/:id/progress` | Record lesson progress/completion                | intrinsic SELF            |
| 92  | `GET /learning/progress`     | Caller's progress across courses                 | intrinsic SELF            |
| 93  | `POST /learning/assignments` | Assign course to member/team                     | `learning.assign`         |
| 94  | `GET /learning/assignments`  | List assignments (scope-filtered)                | `learning.assign`         |

### 4.9 CRM

| #   | Method & path                       | Purpose                                             | Permission            |
| --- | ----------------------------------- | --------------------------------------------------- | --------------------- |
| 95  | `GET /crm/leads`                    | List leads (scope: own / team / tenant)             | `crm.lead.view`       |
| 96  | `POST /crm/leads`                   | Create lead                                         | `crm.lead.manage`     |
| 97  | `GET /crm/leads/:id`                | Lead detail with interactions                       | `crm.lead.view`       |
| 98  | `PATCH /crm/leads/:id`              | Update lead / pipeline stage                        | `crm.lead.manage`     |
| 99  | `POST /crm/leads/:id/convert`       | Convert lead → customer (emits `CustomerConverted`) | `crm.lead.manage`     |
| 100 | `GET /crm/customers`                | List customers                                      | `crm.customer.view`   |
| 101 | `GET /crm/customers/:id`            | Customer detail                                     | `crm.customer.view`   |
| 102 | `PATCH /crm/customers/:id`          | Update customer                                     | `crm.customer.manage` |
| 103 | `GET /crm/follow-ups`               | List follow-ups (`?due=today                        | overdue`)             | `crm.followup.view` |
| 104 | `POST /crm/follow-ups`              | Create follow-up                                    | `crm.followup.manage` |
| 105 | `PATCH /crm/follow-ups/:id`         | Update/reschedule follow-up                         | `crm.followup.manage` |
| 106 | `POST /crm/follow-ups/:id/complete` | Complete follow-up                                  | `crm.followup.manage` |
| 107 | `GET /crm/pipeline`                 | Pipeline stage configuration                        | `crm.lead.view`       |
| 108 | `PATCH /crm/pipeline`               | Configure pipeline stages                           | `crm.pipeline.manage` |

**Example — create lead**

```http
POST /api/v1/crm/leads
Authorization: Bearer eyJ…
Idempotency-Key: 4f9d2c1e-7b3a-4e5f-9c8d-1a2b3c4d5e6f
Content-Type: application/json

{
  "display_name": "Khun Nid",
  "channel": "line",
  "phone": "+66812345678",
  "interest": "better_sleep",
  "note": "Met at Saturday wellness event",
  "stage": "lead"
}
```

```json
{
  "data": {
    "id": "018f8b21-3333-7abc-9def-00000000c001",
    "tenant_id": "018f6f3a-1111-7abc-9def-000000000001",
    "owner_member_id": "018f7a10-4444-7abc-9def-00000000m001",
    "display_name": "Khun Nid",
    "stage": "lead",
    "channel": "line",
    "created_at": "2026-08-19T10:15:00+07:00",
    "updated_at": "2026-08-19T10:15:00+07:00"
  }
}
```

### 4.10 Notifications

| #   | Method & path                       | Purpose                                        | Permission          |
| --- | ----------------------------------- | ---------------------------------------------- | ------------------- |
| 109 | `GET /notifications`                | Caller's in-app notifications                  | intrinsic SELF      |
| 110 | `POST /notifications/:id/read`      | Mark one read                                  | intrinsic SELF      |
| 111 | `POST /notifications/read-all`      | Mark all read                                  | intrinsic SELF      |
| 112 | `GET /notifications/preferences`    | Channel preferences (in-app/email/push/LINE)   | intrinsic SELF      |
| 113 | `PATCH /notifications/preferences`  | Update preferences                             | intrinsic SELF      |
| 114 | `POST /notifications/announcements` | Send announcement to team/tenant (scope-bound) | `notification.send` |

### 4.11 AI Assistant

| #   | Method & path                  | Purpose                                         | Permission                       |
| --- | ------------------------------ | ----------------------------------------------- | -------------------------------- |
| 115 | `POST /ai/assistant/messages`  | Send message to assistant (SSE stream response) | `ai.assistant.use` + entitlement |
| 116 | `GET /ai/conversations`        | Caller's conversations                          | `ai.conversation.view`           |
| 117 | `GET /ai/conversations/:id`    | Conversation transcript                         | `ai.conversation.view`           |
| 118 | `DELETE /ai/conversations/:id` | Delete own conversation                         | `ai.conversation.view`           |
| 119 | `GET /ai/usage`                | Tenant AI usage & cost report                   | `ai.usage.view`                  |

### 4.12 Audit Logs

| #   | Method & path         | Purpose                                                  | Permission   |
| --- | --------------------- | -------------------------------------------------------- | ------------ |
| 120 | `GET /audit-logs`     | Search audit trail (`?actor=&entity=&action=&from=&to=`) | `audit.view` |
| 121 | `GET /audit-logs/:id` | Single audit record with `before`/`after`                | `audit.view` |

### 4.13 Dashboards

| #   | Method & path            | Purpose                                                  | Permission              |
| --- | ------------------------ | -------------------------------------------------------- | ----------------------- |
| 122 | `GET /dashboards/me`     | Personal dashboard (goals, learning, CRM, activity)      | `dashboard.member.view` |
| 123 | `GET /dashboards/tenant` | Tenant dashboard (members, retention, revenue, AI usage) | `dashboard.tenant.view` |

_(Team dashboards are `GET /teams/:id/dashboard`, #70. Platform dashboard is #17.)_

### 4.14 Operations (unauthenticated, infrastructure only)

| #   | Method & path  | Purpose                                   |
| --- | -------------- | ----------------------------------------- |
| 124 | `GET /healthz` | Liveness probe                            |
| 125 | `GET /readyz`  | Readiness probe (DB, Redis, queue checks) |

> **Catalog size: 125 endpoints** (10 auth · 7 platform · 10 tenant config · 10 membership ·
> 12 members · 5 invitations · 16 teams · 10 goals/dreams · 14 learning · 14 CRM ·
> 6 notifications · 5 AI · 2 audit · 2 dashboards · 2 ops).

---

## 5. Pagination — Cursor Format

All list endpoints use **cursor pagination** (stable under inserts, uuid v7 = time-ordered).

Request:

```http
GET /api/v1/members?limit=25&cursor=eyJpZCI6IjAxOGY3YTEwLuKApiJ9
```

Response envelope:

```json
{
  "data": [{ "id": "018f7a10-…", "display_name": "…" }],
  "page": {
    "limit": 25,
    "next_cursor": "eyJpZCI6IjAxOGY3YTEwLuKApiJ9",
    "has_more": true
  }
}
```

Rules:

- `cursor` is an opaque base64url token (internally `{last_id, sort_key}`); clients must not parse it.
- `limit` default 25, max 100.
- `next_cursor` is `null` on the last page. No `total_count` on default lists (expensive); `?include_total=true` is available on admin lists only.

---

## 6. Error Envelope

Every non-2xx response uses one shape:

```json
{
  "error": {
    "code": "TEAM_SCOPE_DENIED",
    "message": "You are not authorized to view members of this team.",
    "details": [{ "field": "team_id", "issue": "outside_authorized_scope" }],
    "request_id": "req_018f9c32-5555-7abc-9def-00000000e001"
  }
}
```

| HTTP | Representative codes                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_FAILED`, `INVALID_CURSOR`                                                                         |
| 401  | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `SESSION_REVOKED`                                                         |
| 403  | `PERMISSION_DENIED`, `TEAM_SCOPE_DENIED`, `ENTITLEMENT_MISSING`, `TENANT_MISMATCH`, `HEALTH_CONSENT_REQUIRED` |
| 404  | `NOT_FOUND`, `TENANT_NOT_FOUND`                                                                               |
| 409  | `CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `INVITATION_ALREADY_ACCEPTED`                                           |
| 422  | `BUSINESS_RULE_VIOLATION` (e.g., moving a team under its own descendant)                                      |
| 429  | `RATE_LIMITED` (with `Retry-After`)                                                                           |
| 500  | `INTERNAL_ERROR` (no internal details leaked; correlate via `request_id`)                                     |

`message` is localized (th/en) per `Accept-Language`. `details` is optional and
machine-readable (zod/class-validator issues map here). `request_id` always matches the
`X-Request-ID` response header and the structured logs (doc 19).

---

## 7. Idempotency Keys

All **mutating** endpoints (`POST`, `PATCH`, `DELETE`) accept:

```http
Idempotency-Key: <uuid v4/v7, client-generated>
```

- Scope: `(tenant_id, user_id, method, path, idempotency_key)`.
- First execution stores the response (Redis, TTL 24 h); replays return the stored response with header `Idempotency-Replayed: true`.
- Same key with a **different request body** → `409 IDEMPOTENCY_KEY_REUSED`.
- **Required** (server rejects without it) on payment-adjacent and irreversible actions: membership assign/cancel, team move, invitation create. Recommended everywhere else.

---

## 8. Rate Limiting

Token-bucket per `(tenant_id, user_id)` with a per-IP pre-auth layer. Enforced in
middleware backed by Redis; limits configurable per tenant plan.

| Tier            | Applies to                                                   | Default limit                                          |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `auth`          | `/auth/login`, `/auth/register`, `/auth/password/*`          | 10 req / 15 min / IP + per-account lockout backoff     |
| `read`          | All `GET`                                                    | 600 req / min / user                                   |
| `write`         | All mutations                                                | 120 req / min / user                                   |
| `expensive`     | `/ai/assistant/*`, exports, `/teams/:id/descendants` (large) | 20 req / min / user + daily AI token budget per tenant |
| `tenant-global` | Whole tenant (all users)                                     | 5,000 req / min (plan-scaled)                          |

Response headers on every request: `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset`. On limit: `429` with `Retry-After`.

---

## 9. Versioning Policy

- URI major version only: `/api/v1`. No date-based or header-based versioning in MVP.
- **Non-breaking** (allowed within v1): adding endpoints, optional request fields, response fields, enum values (clients must ignore unknown fields/values).
- **Breaking** (requires `/api/v2`): removing/renaming fields, changing types/semantics, tightening validation on existing fields, changing error codes.
- Deprecation flow: `Deprecation: true` + `Sunset: <RFC 8594 date>` headers ≥ 6 months before removal; deprecations listed in the changelog and surfaced in tenant admin.
- v1 and v2 run side by side during migration windows; platform endpoints follow the same policy.

Related docs: [07-role-permission-matrix.md](./07-role-permission-matrix.md) · [13-security-architecture.md](./13-security-architecture.md) · [19-observability.md](./19-observability.md)
