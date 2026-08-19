# 08 — Data Model (MVP Database Design)

> AVIORA — Multi-Tenant Membership, Healthy Living & Growth Operating System
> Status: Approved for MVP · Last updated: 2026-08-19
> Spec references: §4–§18 (tenancy, identity, membership, teams, referral), §61 (database), §66 (core entities), §60 (audit), §65 (events)

PostgreSQL 17 + Prisma. Shared database, shared schema, `tenant_id` on every tenant-owned row, Row-Level Security as the second line of defense (spec §61). This document is the single source of truth for the physical schema.

---

## 1. Global Conventions

### 1.1 Naming & ORM

- Tables and columns are **snake_case** in PostgreSQL; Prisma models/fields are **camelCase** mapped via `@map` / `@@map`.

```prisma
model MembershipPlan {
  id        String   @id @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
  trialDays Int      @default(0) @map("trial_days")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  @@map("membership_plans")
}
```

### 1.2 Primary keys — UUID v7

- Every PK is `uuid`, **generated in the application** as UUID v7 (time-ordered → index-friendly inserts, no DB extension dependency). Column: `id uuid PRIMARY KEY`.
- FKs are always `uuid` and named `<entity>_id`.

### 1.3 Timestamps — timestamptz everywhere

- **Every** timestamp column is `timestamptz` (Prisma `DateTime @db.Timestamptz(6)`). `timestamp without time zone` is banned.
- Every table has `created_at timestamptz NOT NULL DEFAULT now()` and `updated_at timestamptz NOT NULL DEFAULT now()` (maintained by Prisma `@updatedAt`).
- Store UTC; convert at the edge (frontend/report layer renders in tenant/member timezone).
- Pure calendar values with no timezone meaning (e.g. `birth_date`, goal `due_date`) use `date`.

### 1.4 tenant_id convention

- Every **tenant-owned** table has `tenant_id uuid NOT NULL REFERENCES tenants(id)` as its second column.
- Every composite index leads with `tenant_id`.
- Every unique business constraint is scoped by tenant: `UNIQUE(tenant_id, code)`, never `UNIQUE(code)`.
- **Platform tables** (no `tenant_id`, RLS-exempt): `tenants`, `users`, `entitlements`, `permissions` — global identity and pure-platform configuration.

### 1.5 Row-Level Security (RLS) pattern

RLS is enabled on all tenant-owned tables. The application sets the tenant per connection/transaction:

```sql
-- set by the API layer (TenantContext middleware) at transaction start
SET LOCAL app.tenant_id = '0198f3c2-7c1a-7bbb-8000-2f4e9a1d0c11';
```

Canonical policy (one per tenant-owned table — example on `members`):

```sql
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON members
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

- The app connects as a **non-superuser role without `BYPASSRLS`**.
- **Defense in depth**: the application layer _also_ filters every query by `tenant_id` (Prisma middleware injects `where: { tenantId }`). RLS is the net, not the only fence. Highest-priority test (spec §69): Tenant A must never read Tenant B data even with an app-layer bug.
- Platform-admin jobs (cross-tenant reporting, migrations) use a dedicated role with an explicit bypass policy, never the API role.
- Hybrid exception: `roles` allows platform-defined rows via `tenant_id IS NULL OR tenant_id = current_setting(...)` (see §3.5).

### 1.6 Soft delete & effective dates — never destroy organization history (spec §16)

- **No hard deletes** on business data. Three mechanisms, chosen per table:
  1. **Status columns** (`status = 'archived'`) for catalog-like rows (plans, teams, courses).
  2. **Effective-dated rows** for relationship history: `team_memberships`, `team_leaderships`, `referral_relationships` carry `joined_at/left_at` or `effective_from/effective_to`. Ending a relationship sets the end date + status; a new relationship is a **new row**. Queries for "current" filter `left_at IS NULL` / `effective_to IS NULL`.
  3. **`deleted_at timestamptz NULL`** soft-delete marker for user-generated content that can be "removed" from UI (goals, dreams, leads, follow-ups, notifications). Unique indexes that must ignore deleted rows are partial: `WHERE deleted_at IS NULL`.
- Every mutation of sensitive entities also writes `audit_logs` (spec §60).

### 1.7 Money, JSON, i18n

- Money: `numeric(12,2)` + companion `currency char(3)` (ISO 4217). Never float.
- `jsonb` for `settings`, `metadata`, `branding`, `feature_flags`, rule documents.
- Multi-language content fields are **jsonb i18n maps**: `{"th": "สุขภาพดี", "en": "Healthy Living"}` — marked _(i18n)_ below.

### 1.8 Legend for the tables below

Every table implicitly includes `id uuid PK` (UUID v7) and `created_at` / `updated_at timestamptz NOT NULL DEFAULT now()` — not repeated in each listing. `NN` = NOT NULL. All FKs are `ON DELETE RESTRICT` unless noted (history preservation).

---

## 2. MVP vs Reserved Scope

| Build wave                                                                          | Tables                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MVP — Sprint 1** (identity, tenancy, membership, RBAC)                            | `tenants`, `tenant_settings`, `tenant_features`, `users`, `tenant_memberships`, `members`, `member_profiles`, `lifecycle_stages`, `invitations`, `membership_plans`, `memberships`, `entitlements`, `plan_entitlements`, `roles`, `permissions`, `role_permissions`, `member_roles`, `audit_logs`, `domain_events` |
| **MVP — Sprint 2** (teams, referral, growth, learning, CRM, notifications, AI-lite) | `teams`, `team_memberships`, `team_leaderships`, `team_closure`, `referral_relationships`, `goals`, `dreams`, `courses`, `lessons`, `learning_progress`, `leads`, `customers`, `follow_ups`, `interactions`, `notifications`, `notification_preferences`, `ai_conversations`, `ai_messages`, `ai_usage`            |
| **Phase 2/3 — schema reserved, NOT built in MVP**                                   | See §6                                                                                                                                                                                                                                                                                                             |

**MVP total: 38 tables.**

---

## 3. MVP Tables — Sprint 1

### 3.1 `tenants` — platform table (RLS-exempt) · spec §5

| Column                 | Type    | Null | Default / Constraint                                                                    |
| ---------------------- | ------- | ---- | --------------------------------------------------------------------------------------- |
| `code`                 | text    | NN   | `UNIQUE` — stable machine code                                                          |
| `name`                 | text    | NN   |                                                                                         |
| `slug`                 | text    | NN   | `UNIQUE` — subdomain: `slug.platform.com`                                               |
| `legal_name`           | text    | NULL |                                                                                         |
| `tenant_type`          | text    | NN   | e.g. `wellness_business`, `membership_club`, `academy`, … (spec §5 list; not a DB enum) |
| `status`               | text    | NN   | `'pending'` — `pending` \| `active` \| `suspended` \| `archived`                        |
| `logo_url`             | text    | NULL |                                                                                         |
| `primary_domain`       | text    | NULL | `UNIQUE` — `slug.platform.com` resolved value                                           |
| `custom_domain`        | text    | NULL | `UNIQUE`                                                                                |
| `country`              | char(2) | NN   | ISO 3166-1                                                                              |
| `timezone`             | text    | NN   | `'Asia/Bangkok'` (IANA)                                                                 |
| `default_language`     | char(2) | NN   | `'th'`                                                                                  |
| `default_currency`     | char(3) | NN   | `'THB'`                                                                                 |
| `subscription_plan_id` | uuid    | NULL | Platform SaaS plan (billing of tenants — Phase 2 table)                                 |
| `branding`             | jsonb   | NN   | `'{}'` — colors, fonts, app name (spec §56)                                             |
| `settings`             | jsonb   | NN   | `'{}'`                                                                                  |
| `feature_flags`        | jsonb   | NN   | `'{}'`                                                                                  |
| `metadata`             | jsonb   | NN   | `'{}'`                                                                                  |

Indexes: `UNIQUE(code)`, `UNIQUE(slug)`, `UNIQUE(custom_domain)`, `(status)`.

### 3.2 `tenant_settings`

Key-value overflow for structured, individually-updatable settings (lifecycle config, CRM pipeline stages, grace periods…).

| Column               | Type  | Null | Default / Constraint                              |
| -------------------- | ----- | ---- | ------------------------------------------------- |
| `tenant_id`          | uuid  | NN   | FK → `tenants.id`                                 |
| `key`                | text  | NN   | dot notation, e.g. `membership.grace_period_days` |
| `value`              | jsonb | NN   |                                                   |
| `updated_by_user_id` | uuid  | NULL | FK → `users.id`                                   |

Constraints: `UNIQUE(tenant_id, key)`. Index: `(tenant_id, key)`.

### 3.3 `tenant_features`

Feature toggles per tenant (drives module visibility, spec §56 feature visibility).

| Column        | Type    | Null | Default / Constraint                                |
| ------------- | ------- | ---- | --------------------------------------------------- |
| `tenant_id`   | uuid    | NN   | FK → `tenants.id`                                   |
| `feature_key` | text    | NN   | e.g. `crm`, `learning`, `ai.assistant`, `community` |
| `enabled`     | boolean | NN   | `false`                                             |
| `config`      | jsonb   | NN   | `'{}'`                                              |

Constraints: `UNIQUE(tenant_id, feature_key)`.

### 3.4 `users` — platform table (RLS-exempt) · spec §7

Global authentication identity. **Email unique globally.**

| Column              | Type        | Null | Default / Constraint                                                                                       |
| ------------------- | ----------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `email`             | citext      | NN   | `UNIQUE`                                                                                                   |
| `email_verified_at` | timestamptz | NULL |                                                                                                            |
| `password_hash`     | text        | NULL | NULL for SSO-only users                                                                                    |
| `name`              | text        | NN   |                                                                                                            |
| `avatar_url`        | text        | NULL |                                                                                                            |
| `phone`             | text        | NULL |                                                                                                            |
| `locale`            | char(2)     | NN   | `'th'`                                                                                                     |
| `timezone`          | text        | NN   | `'Asia/Bangkok'`                                                                                           |
| `status`            | text        | NN   | `'active'` — `active` \| `suspended` \| `deactivated`                                                      |
| `mfa_enabled`       | boolean     | NN   | `false`                                                                                                    |
| `mfa_secret_enc`    | text        | NULL | encrypted at rest                                                                                          |
| `last_login_at`     | timestamptz | NULL |                                                                                                            |
| `platform_role`     | text        | NULL | `platform_owner` \| `super_admin` \| `support` \| `finance` \| `analyst` (spec §57); NULL for normal users |
| `metadata`          | jsonb       | NN   | `'{}'`                                                                                                     |

Indexes: `UNIQUE(email)`, `(status)`.

### 3.5 `tenant_memberships` — User ↔ Tenant link · spec §7

One User can belong to multiple tenants; powers the tenant switcher.

| Column               | Type        | Null | Default / Constraint                                                                                               |
| -------------------- | ----------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| `tenant_id`          | uuid        | NN   | FK → `tenants.id`                                                                                                  |
| `user_id`            | uuid        | NN   | FK → `users.id`                                                                                                    |
| `status`             | text        | NN   | `'invited'` — `invited` \| `active` \| `suspended` \| `left`                                                       |
| `is_owner`           | boolean     | NN   | `false` — tenant owner flag                                                                                        |
| `roles`              | text[]      | NN   | `'{}'` — tenant-level admin roles for this user (e.g. `{tenant_admin}`); member-level RBAC lives in `member_roles` |
| `invited_by_user_id` | uuid        | NULL | FK → `users.id`                                                                                                    |
| `joined_at`          | timestamptz | NULL |                                                                                                                    |
| `left_at`            | timestamptz | NULL | history preserved — no row deletion                                                                                |

Constraints: `UNIQUE(tenant_id, user_id)`. Indexes: `(user_id)` (tenant switcher lookup), `(tenant_id, status)`.

### 3.6 `members` — per-tenant person · spec §7, §10

| Column               | Type        | Null | Default / Constraint                                             |
| -------------------- | ----------- | ---- | ---------------------------------------------------------------- |
| `tenant_id`          | uuid        | NN   | FK → `tenants.id`                                                |
| `user_id`            | uuid        | NN   | FK → `users.id`                                                  |
| `member_code`        | text        | NN   | tenant-visible ID, `UNIQUE(tenant_id, member_code)`              |
| `display_name`       | text        | NN   |                                                                  |
| `status`             | text        | NN   | `'active'` — `active` \| `inactive` \| `suspended` \| `archived` |
| `lifecycle_stage_id` | uuid        | NULL | FK → `lifecycle_stages.id` (configurable journey, spec §3/§23)   |
| `joined_at`          | timestamptz | NN   | `now()`                                                          |
| `custom_fields`      | jsonb       | NN   | `'{}'` — tenant-specific fields (spec §10)                       |
| `metadata`           | jsonb       | NN   | `'{}'`                                                           |
| `deleted_at`         | timestamptz | NULL | soft delete                                                      |

Constraints: `UNIQUE(tenant_id, user_id)`, `UNIQUE(tenant_id, member_code)`. Indexes: `(tenant_id, status)`, `(tenant_id, lifecycle_stage_id)`, `(user_id)`.

### 3.7 `member_profiles` — 1:1 extension

| Column         | Type    | Null | Default / Constraint                 |
| -------------- | ------- | ---- | ------------------------------------ |
| `tenant_id`    | uuid    | NN   | FK → `tenants.id`                    |
| `member_id`    | uuid    | NN   | FK → `members.id`, `UNIQUE` (1:1)    |
| `avatar_url`   | text    | NULL |                                      |
| `bio`          | text    | NULL |                                      |
| `birth_date`   | date    | NULL | calendar value — deliberately `date` |
| `gender`       | text    | NULL |                                      |
| `phone`        | text    | NULL |                                      |
| `address`      | jsonb   | NULL | structured, country-aware (spec §55) |
| `social_links` | jsonb   | NN   | `'{}'`                               |
| `locale`       | char(2) | NULL | overrides user locale within tenant  |
| `preferences`  | jsonb   | NN   | `'{}'`                               |

Constraints: `UNIQUE(member_id)`. Index: `(tenant_id)`. Health profile data is **not** stored here (spec §59) — reserved `health_profiles` table, Phase 2.

### 3.8 `lifecycle_stages` — configurable member journey · spec §3, §23

| Column         | Type    | Null | Default / Constraint                              |
| -------------- | ------- | ---- | ------------------------------------------------- |
| `tenant_id`    | uuid    | NN   | FK → `tenants.id`                                 |
| `code`         | text    | NN   | e.g. `lead`, `member`, `builder`, `leader`        |
| `name`         | jsonb   | NN   | _(i18n)_                                          |
| `description`  | jsonb   | NULL | _(i18n)_                                          |
| `sort_order`   | integer | NN   | `0`                                               |
| `requirements` | jsonb   | NN   | `'{}'` — declarative stage-entry rules (spec §23) |
| `is_active`    | boolean | NN   | `true`                                            |

Constraints: `UNIQUE(tenant_id, code)`. Index: `(tenant_id, sort_order)`.

### 3.9 `invitations`

| Column               | Type        | Null | Default / Constraint                                            |
| -------------------- | ----------- | ---- | --------------------------------------------------------------- |
| `tenant_id`          | uuid        | NN   | FK → `tenants.id`                                               |
| `email`              | citext      | NN   |                                                                 |
| `token_hash`         | text        | NN   | `UNIQUE` — hashed invite token (never store plaintext)          |
| `invited_by_user_id` | uuid        | NN   | FK → `users.id`                                                 |
| `role_id`            | uuid        | NULL | FK → `roles.id` — role to grant on acceptance                   |
| `team_id`            | uuid        | NULL | FK → `teams.id` — team to join on acceptance                    |
| `membership_plan_id` | uuid        | NULL | FK → `membership_plans.id` — plan to start on acceptance        |
| `status`             | text        | NN   | `'pending'` — `pending` \| `accepted` \| `expired` \| `revoked` |
| `expires_at`         | timestamptz | NN   |                                                                 |
| `accepted_at`        | timestamptz | NULL |                                                                 |
| `accepted_user_id`   | uuid        | NULL | FK → `users.id`                                                 |

Indexes: `(tenant_id, email, status)`, `UNIQUE(token_hash)`.

### 3.10 `membership_plans` · spec §8 — see [04-membership-model.md](./04-membership-model.md)

| Column              | Type          | Null | Default / Constraint                                                                   |
| ------------------- | ------------- | ---- | -------------------------------------------------------------------------------------- |
| `tenant_id`         | uuid          | NN   | FK → `tenants.id`                                                                      |
| `code`              | text          | NN   | `UNIQUE(tenant_id, code)`                                                              |
| `name`              | jsonb         | NN   | _(i18n)_                                                                               |
| `description`       | jsonb         | NULL | _(i18n)_                                                                               |
| `membership_type`   | text          | NN   | spec §8 list; informational only                                                       |
| `price`             | numeric(12,2) | NN   | `0.00`                                                                                 |
| `currency`          | char(3)       | NN   | tenant default                                                                         |
| `billing_cycle`     | text          | NN   | `free` \| `one_time` \| `monthly` \| `quarterly` \| `yearly` \| `lifetime` \| `custom` |
| `trial_days`        | integer       | NN   | `0`                                                                                    |
| `benefits`          | jsonb         | NN   | `'[]'` _(i18n items — display only)_                                                   |
| `features`          | jsonb         | NN   | `'[]'`                                                                                 |
| `limits`            | jsonb         | NN   | `'{}'`                                                                                 |
| `eligibility_rules` | jsonb         | NN   | `'{}'`                                                                                 |
| `status`            | text          | NN   | `'draft'` — `draft` \| `active` \| `archived`                                          |
| `metadata`          | jsonb         | NN   | `'{}'`                                                                                 |

Indexes: `UNIQUE(tenant_id, code)`, `(tenant_id, status)`.

### 3.11 `memberships` — plan instance · doc 04

| Column                 | Type          | Null | Default / Constraint                                                      |
| ---------------------- | ------------- | ---- | ------------------------------------------------------------------------- |
| `tenant_id`            | uuid          | NN   | FK → `tenants.id`                                                         |
| `member_id`            | uuid          | NN   | FK → `members.id`                                                         |
| `plan_id`              | uuid          | NN   | FK → `membership_plans.id`                                                |
| `status`               | text          | NN   | `'draft'` — `draft` \| `active` \| `past_due` \| `expired` \| `cancelled` |
| `billing_cycle`        | text          | NN   | snapshot from plan                                                        |
| `price`                | numeric(12,2) | NN   | snapshot                                                                  |
| `currency`             | char(3)       | NN   | snapshot                                                                  |
| `started_at`           | timestamptz   | NULL | set on activation                                                         |
| `trial_ends_at`        | timestamptz   | NULL |                                                                           |
| `current_period_start` | timestamptz   | NULL |                                                                           |
| `current_period_end`   | timestamptz   | NULL |                                                                           |
| `expires_at`           | timestamptz   | NULL |                                                                           |
| `cancelled_at`         | timestamptz   | NULL |                                                                           |
| `cancel_reason`        | text          | NULL |                                                                           |
| `auto_renew`           | boolean       | NN   | `true`                                                                    |
| `metadata`             | jsonb         | NN   | `'{}'`                                                                    |

Constraints: partial unique — one open membership per member:
`CREATE UNIQUE INDEX memberships_one_open ON memberships (tenant_id, member_id) WHERE status IN ('draft','active','past_due');`
Indexes: `(tenant_id, member_id, status)`, `(tenant_id, status, current_period_end)` (expiring scan), `(tenant_id, plan_id)`.

### 3.12 `entitlements` — platform catalog (RLS-exempt) · spec §9

| Column        | Type    | Null | Default / Constraint                                                    |
| ------------- | ------- | ---- | ----------------------------------------------------------------------- |
| `key`         | text    | NN   | `UNIQUE` — dot notation (`course.access`, `ai.coach`, `team.create`, …) |
| `name`        | jsonb   | NN   | _(i18n)_                                                                |
| `description` | jsonb   | NULL | _(i18n)_                                                                |
| `value_type`  | text    | NN   | `'boolean'` — `boolean` \| `limit` \| `enum`                            |
| `category`    | text    | NN   | admin-UI grouping                                                       |
| `is_active`   | boolean | NN   | `true`                                                                  |

### 3.13 `plan_entitlements`

| Column           | Type  | Null | Default / Constraint                                 |
| ---------------- | ----- | ---- | ---------------------------------------------------- |
| `tenant_id`      | uuid  | NN   | FK → `tenants.id`                                    |
| `plan_id`        | uuid  | NN   | FK → `membership_plans.id`                           |
| `entitlement_id` | uuid  | NN   | FK → `entitlements.id`                               |
| `value`          | jsonb | NN   | `'true'` — interpreted per `entitlements.value_type` |

Constraints: `UNIQUE(tenant_id, plan_id, entitlement_id)`. Index: `(tenant_id, plan_id)`.

### 3.14 `roles` — hybrid platform/tenant · spec §57

| Column        | Type    | Null     | Default / Constraint                                            |
| ------------- | ------- | -------- | --------------------------------------------------------------- |
| `tenant_id`   | uuid    | **NULL** | FK → `tenants.id`; NULL = platform-defined system role template |
| `code`        | text    | NN       | e.g. `tenant_admin`, `leader`, `coach`, `member`                |
| `name`        | jsonb   | NN       | _(i18n)_                                                        |
| `description` | jsonb   | NULL     | _(i18n)_                                                        |
| `is_system`   | boolean | NN       | `false` — system roles are read-only for tenants                |
| `is_active`   | boolean | NN       | `true`                                                          |

Constraints: `UNIQUE NULLS NOT DISTINCT (tenant_id, code)`. RLS policy variant: `USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id')::uuid)` — tenants see system roles + their own custom roles (spec §57: tenants create custom roles).

### 3.15 `permissions` — platform catalog (RLS-exempt) · spec §19, §57, §59

| Column          | Type    | Null | Default / Constraint                                                                         |
| --------------- | ------- | ---- | -------------------------------------------------------------------------------------------- |
| `key`           | text    | NN   | `UNIQUE` — dot notation: `team.member.view`, `team.analytics.view`, `health.profile.view`, … |
| `name`          | jsonb   | NN   | _(i18n)_                                                                                     |
| `description`   | jsonb   | NULL | _(i18n)_                                                                                     |
| `category`      | text    | NN   | domain grouping                                                                              |
| `default_scope` | text    | NN   | `'SELF'` — `SELF` \| `DIRECT_TEAM` \| `DESCENDANT_TEAMS` \| `SPECIFIC_TEAMS` \| `TENANT_ALL` |
| `is_active`     | boolean | NN   | `true`                                                                                       |

### 3.16 `role_permissions`

| Column          | Type  | Null | Default / Constraint                                     |
| --------------- | ----- | ---- | -------------------------------------------------------- |
| `tenant_id`     | uuid  | NULL | matches `roles.tenant_id` (NULL for system-role grants)  |
| `role_id`       | uuid  | NN   | FK → `roles.id`                                          |
| `permission_id` | uuid  | NN   | FK → `permissions.id`                                    |
| `scope`         | text  | NN   | `'SELF'` — scope granted (spec §19)                      |
| `scope_config`  | jsonb | NN   | `'{}'` — e.g. `{"team_ids": [...]}` for `SPECIFIC_TEAMS` |

Constraints: `UNIQUE NULLS NOT DISTINCT (tenant_id, role_id, permission_id)`. Index: `(role_id)`.

### 3.17 `member_roles`

| Column               | Type        | Null | Default / Constraint                                |
| -------------------- | ----------- | ---- | --------------------------------------------------- |
| `tenant_id`          | uuid        | NN   | FK → `tenants.id`                                   |
| `member_id`          | uuid        | NN   | FK → `members.id`                                   |
| `role_id`            | uuid        | NN   | FK → `roles.id`                                     |
| `granted_by_user_id` | uuid        | NULL | FK → `users.id`                                     |
| `effective_from`     | timestamptz | NN   | `now()`                                             |
| `effective_to`       | timestamptz | NULL | NULL = current; revocation sets this, never deletes |

Constraints: partial unique `UNIQUE(tenant_id, member_id, role_id) WHERE effective_to IS NULL`. Indexes: `(tenant_id, member_id)`, `(tenant_id, role_id)`.

### 3.18 `audit_logs` · spec §60

| Column        | Type        | Null | Default / Constraint                                                |
| ------------- | ----------- | ---- | ------------------------------------------------------------------- |
| `tenant_id`   | uuid        | NULL | NULL for platform-level actions                                     |
| `user_id`     | uuid        | NULL | FK → `users.id` — acting user                                       |
| `member_id`   | uuid        | NULL | FK → `members.id` — acting member context                           |
| `action`      | text        | NN   | e.g. `membership.activate`, `team.move`, `leader.assign`            |
| `entity_type` | text        | NN   | aggregate name                                                      |
| `entity_id`   | uuid        | NULL |                                                                     |
| `before`      | jsonb       | NULL | prior state (sensitive fields redacted)                             |
| `after`       | jsonb       | NULL | new state                                                           |
| `ip`          | inet        | NULL |                                                                     |
| `user_agent`  | text        | NULL |                                                                     |
| `request_id`  | uuid        | NULL | correlates with tracing (spec §68)                                  |
| `created_at`  | timestamptz | NN   | `now()` — append-only; **no `updated_at`**, no UPDATE/DELETE grants |

Indexes: `(tenant_id, created_at)`, `(tenant_id, entity_type, entity_id)`, `(tenant_id, user_id, created_at)`. Partitioning by month is deferred until volume requires it.

### 3.19 `domain_events` — transactional outbox · spec §64–§65

| Column           | Type        | Null | Default / Constraint                               |
| ---------------- | ----------- | ---- | -------------------------------------------------- |
| `event_name`     | text        | NN   | `MembershipActivated`, `TeamCreated`, … (spec §65) |
| `tenant_id`      | uuid        | NULL | NULL for platform events (`TenantCreated`)         |
| `aggregate_type` | text        | NN   |                                                    |
| `aggregate_id`   | uuid        | NN   |                                                    |
| `actor_user_id`  | uuid        | NULL | FK → `users.id`                                    |
| `payload`        | jsonb       | NN   |                                                    |
| `occurred_at`    | timestamptz | NN   | `now()`                                            |
| `processed_at`   | timestamptz | NULL | NULL = pending dispatch                            |
| `attempts`       | integer     | NN   | `0`                                                |

Indexes: partial `(occurred_at) WHERE processed_at IS NULL` (dispatcher poll), `(tenant_id, aggregate_type, aggregate_id)`. Written in the **same transaction** as the state change; a relay dispatches to in-process handlers/queue, marks `processed_at`, increments `attempts` on failure (dead-letter after N).

---

## 4. MVP Tables — Sprint 2

### 4.1 `teams` · spec §12

| Column              | Type  | Null | Default / Constraint                                                                     |
| ------------------- | ----- | ---- | ---------------------------------------------------------------------------------------- |
| `tenant_id`         | uuid  | NN   | FK → `tenants.id`                                                                        |
| `parent_team_id`    | uuid  | NULL | self-FK → `teams.id`; NULL = root team                                                   |
| `team_type`         | text  | NN   | `'standard'` — tenant-definable                                                          |
| `code`              | text  | NN   | `UNIQUE(tenant_id, code)`                                                                |
| `name`              | text  | NN   |                                                                                          |
| `slug`              | text  | NN   | `UNIQUE(tenant_id, slug)`                                                                |
| `description`       | text  | NULL |                                                                                          |
| `status`            | text  | NN   | `'active'` — `active` \| `archived` (archive, never delete — spec §16)                   |
| `primary_leader_id` | uuid  | NULL | FK → `members.id` (denormalized convenience; authoritative record in `team_leaderships`) |
| `visibility`        | text  | NN   | `'private'` — `private` \| `tenant` \| `public`                                          |
| `settings`          | jsonb | NN   | `'{}'`                                                                                   |
| `metadata`          | jsonb | NN   | `'{}'`                                                                                   |

Indexes: `(tenant_id, parent_team_id)`, `(tenant_id, status)`.

### 4.2 `team_closure` · spec §15

Closure table maintained transactionally alongside `parent_team_id` on create/move/merge. Includes self-rows (`depth = 0`).

| Column               | Type    | Null | Default / Constraint |
| -------------------- | ------- | ---- | -------------------- |
| `tenant_id`          | uuid    | NN   | FK → `tenants.id`    |
| `ancestor_team_id`   | uuid    | NN   | FK → `teams.id`      |
| `descendant_team_id` | uuid    | NN   | FK → `teams.id`      |
| `depth`              | integer | NN   | `0` for self         |

Constraints: `PRIMARY KEY (ancestor_team_id, descendant_team_id)` (no surrogate `id` — deliberate exception). Indexes: `(tenant_id, descendant_team_id)` (ancestor lookup), `(tenant_id, ancestor_team_id, depth)`. No `created_at`/`updated_at` — derived structure, fully rebuilt on move.

### 4.3 `team_memberships` · spec §13

Member ↔ team, many-to-many, effective-dated. Never store `team_id` on `members`.

| Column            | Type        | Null | Default / Constraint                                          |
| ----------------- | ----------- | ---- | ------------------------------------------------------------- |
| `tenant_id`       | uuid        | NN   | FK → `tenants.id`                                             |
| `team_id`         | uuid        | NN   | FK → `teams.id`                                               |
| `member_id`       | uuid        | NN   | FK → `members.id`                                             |
| `role_id`         | uuid        | NULL | FK → `roles.id` — role within this team                       |
| `membership_type` | text        | NN   | `'member'` — tenant-definable                                 |
| `status`          | text        | NN   | `'active'` — `active` \| `left` \| `transferred`              |
| `joined_at`       | timestamptz | NN   | `now()`                                                       |
| `left_at`         | timestamptz | NULL | NULL = current; leaving/transfer sets it — **no hard delete** |
| `metadata`        | jsonb       | NN   | `'{}'`                                                        |

Constraints: partial unique `UNIQUE(tenant_id, team_id, member_id) WHERE left_at IS NULL`. Indexes: `(tenant_id, member_id) WHERE left_at IS NULL`, `(tenant_id, team_id, status)`.

### 4.4 `team_leaderships` · spec §14

| Column            | Type        | Null | Default / Constraint                                                                  |
| ----------------- | ----------- | ---- | ------------------------------------------------------------------------------------- |
| `tenant_id`       | uuid        | NN   | FK → `tenants.id`                                                                     |
| `team_id`         | uuid        | NN   | FK → `teams.id`                                                                       |
| `member_id`       | uuid        | NN   | FK → `members.id`                                                                     |
| `leadership_role` | text        | NN   | `primary_leader` \| `co_leader` \| `manager` \| `coach` \| `mentor` \| tenant-defined |
| `is_primary`      | boolean     | NN   | `false`                                                                               |
| `status`          | text        | NN   | `'active'` — `active` \| `ended`                                                      |
| `effective_from`  | timestamptz | NN   | `now()`                                                                               |
| `effective_to`    | timestamptz | NULL | NULL = current; change of leader ends the old row, inserts a new one                  |
| `metadata`        | jsonb       | NN   | `'{}'`                                                                                |

Constraints: partial unique `UNIQUE(tenant_id, team_id) WHERE is_primary AND effective_to IS NULL` (one current primary leader per team). Indexes: `(tenant_id, team_id) WHERE effective_to IS NULL`, `(tenant_id, member_id) WHERE effective_to IS NULL`.

### 4.5 `referral_relationships` · spec §17–§18

**Separate graph from the team tree — never coupled** (spec §17 mandatory).

| Column               | Type        | Null | Default / Constraint                                                        |
| -------------------- | ----------- | ---- | --------------------------------------------------------------------------- |
| `tenant_id`          | uuid        | NN   | FK → `tenants.id`                                                           |
| `referrer_member_id` | uuid        | NN   | FK → `members.id`                                                           |
| `referred_member_id` | uuid        | NN   | FK → `members.id`                                                           |
| `relationship_type`  | text        | NN   | `referral` \| `sponsor` \| `introducer` \| `affiliate` \| `mentor_referral` |
| `effective_from`     | timestamptz | NN   | `now()`                                                                     |
| `effective_to`       | timestamptz | NULL | NULL = current; re-sponsoring ends old row, inserts new — full history kept |
| `metadata`           | jsonb       | NN   | `'{}'`                                                                      |

Constraints: `CHECK (referrer_member_id <> referred_member_id)`; partial unique `UNIQUE(tenant_id, referred_member_id, relationship_type) WHERE effective_to IS NULL` (one current referrer per type). Indexes: `(tenant_id, referrer_member_id) WHERE effective_to IS NULL`, `(tenant_id, referred_member_id)`.

### 4.6 `goals` · spec §22–§23

| Column          | Type          | Null | Default / Constraint                                                                                                          |
| --------------- | ------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`     | uuid          | NN   | FK → `tenants.id`                                                                                                             |
| `member_id`     | uuid          | NN   | FK → `members.id` — owner                                                                                                     |
| `team_id`       | uuid          | NULL | FK → `teams.id` — team goals (spec §16 "Set goals")                                                                           |
| `dream_id`      | uuid          | NULL | FK → `dreams.id` — goal realizing a dream                                                                                     |
| `goal_type`     | text          | NN   | `life` \| `family` \| `financial` \| `travel` \| `health` \| `learning` \| `business` \| `annual` \| `quarterly` \| `monthly` |
| `title`         | text          | NN   |                                                                                                                               |
| `description`   | text          | NULL |                                                                                                                               |
| `target_value`  | numeric(12,2) | NULL |                                                                                                                               |
| `current_value` | numeric(12,2) | NULL |                                                                                                                               |
| `unit`          | text          | NULL |                                                                                                                               |
| `due_date`      | date          | NULL | calendar value                                                                                                                |
| `status`        | text          | NN   | `'active'` — `active` \| `completed` \| `paused` \| `abandoned`                                                               |
| `completed_at`  | timestamptz   | NULL |                                                                                                                               |
| `metadata`      | jsonb         | NN   | `'{}'`                                                                                                                        |
| `deleted_at`    | timestamptz   | NULL | soft delete                                                                                                                   |

Indexes: `(tenant_id, member_id, status)`, `(tenant_id, team_id) WHERE team_id IS NOT NULL`.

### 4.7 `dreams` · spec §22 (100 Dreams / Vision Board)

| Column        | Type        | Null | Default / Constraint                                     |
| ------------- | ----------- | ---- | -------------------------------------------------------- |
| `tenant_id`   | uuid        | NN   | FK → `tenants.id`                                        |
| `member_id`   | uuid        | NN   | FK → `members.id`                                        |
| `title`       | text        | NN   |                                                          |
| `description` | text        | NULL |                                                          |
| `category`    | text        | NULL |                                                          |
| `image_url`   | text        | NULL | vision board                                             |
| `target_date` | date        | NULL |                                                          |
| `sort_order`  | integer     | NN   | `0`                                                      |
| `status`      | text        | NN   | `'dreaming'` — `dreaming` \| `in_progress` \| `achieved` |
| `achieved_at` | timestamptz | NULL |                                                          |
| `deleted_at`  | timestamptz | NULL | soft delete                                              |

Indexes: `(tenant_id, member_id, status)`.

### 4.8 `courses` · spec §24

| Column             | Type        | Null | Default / Constraint                                     |
| ------------------ | ----------- | ---- | -------------------------------------------------------- |
| `tenant_id`        | uuid        | NN   | FK → `tenants.id`                                        |
| `code`             | text        | NN   | `UNIQUE(tenant_id, code)`                                |
| `title`            | jsonb       | NN   | _(i18n)_                                                 |
| `description`      | jsonb       | NULL | _(i18n)_                                                 |
| `cover_url`        | text        | NULL |                                                          |
| `level`            | text        | NULL |                                                          |
| `status`           | text        | NN   | `'draft'` — `draft` \| `published` \| `archived`         |
| `published_at`     | timestamptz | NULL |                                                          |
| `assignment_rules` | jsonb       | NN   | `'{}'` — assign by membership/role/team/stage (spec §24) |
| `metadata`         | jsonb       | NN   | `'{}'`                                                   |

Indexes: `UNIQUE(tenant_id, code)`, `(tenant_id, status)`.

### 4.9 `lessons`

| Column             | Type    | Null | Default / Constraint                                 |
| ------------------ | ------- | ---- | ---------------------------------------------------- |
| `tenant_id`        | uuid    | NN   | FK → `tenants.id`                                    |
| `course_id`        | uuid    | NN   | FK → `courses.id`                                    |
| `title`            | jsonb   | NN   | _(i18n)_                                             |
| `content_type`     | text    | NN   | `video` \| `audio` \| `document` \| `text` \| `quiz` |
| `content_url`      | text    | NULL | R2 path `/tenants/{tenant_id}/...` (spec §62)        |
| `body`             | jsonb   | NULL | _(i18n)_ rich text                                   |
| `duration_seconds` | integer | NULL |                                                      |
| `sort_order`       | integer | NN   | `0`                                                  |
| `status`           | text    | NN   | `'draft'`                                            |
| `metadata`         | jsonb   | NN   | `'{}'`                                               |

Constraints: `UNIQUE(tenant_id, course_id, sort_order)`. Index: `(tenant_id, course_id, sort_order)`.

### 4.10 `learning_progress`

| Column         | Type         | Null | Default / Constraint                                            |
| -------------- | ------------ | ---- | --------------------------------------------------------------- |
| `tenant_id`    | uuid         | NN   | FK → `tenants.id`                                               |
| `member_id`    | uuid         | NN   | FK → `members.id`                                               |
| `course_id`    | uuid         | NN   | FK → `courses.id`                                               |
| `lesson_id`    | uuid         | NULL | FK → `lessons.id`; NULL = course-level summary row              |
| `status`       | text         | NN   | `'not_started'` — `not_started` \| `in_progress` \| `completed` |
| `progress_pct` | numeric(5,2) | NN   | `0`                                                             |
| `started_at`   | timestamptz  | NULL |                                                                 |
| `completed_at` | timestamptz  | NULL | drives `CourseCompleted` event                                  |
| `metadata`     | jsonb        | NN   | `'{}'`                                                          |

Constraints: `UNIQUE NULLS NOT DISTINCT (tenant_id, member_id, course_id, lesson_id)`. Indexes: `(tenant_id, member_id, status)`, `(tenant_id, course_id)`.

### 4.11 `leads` · spec §34

| Column                  | Type        | Null | Default / Constraint                                                                         |
| ----------------------- | ----------- | ---- | -------------------------------------------------------------------------------------------- |
| `tenant_id`             | uuid        | NN   | FK → `tenants.id`                                                                            |
| `owner_member_id`       | uuid        | NN   | FK → `members.id` — the member working this lead                                             |
| `name`                  | text        | NN   |                                                                                              |
| `email`                 | citext      | NULL |                                                                                              |
| `phone`                 | text        | NULL |                                                                                              |
| `source`                | text        | NULL |                                                                                              |
| `stage`                 | text        | NN   | `'lead'` — tenant-configurable pipeline stage codes (`tenant_settings: crm.pipeline_stages`) |
| `status`                | text        | NN   | `'open'` — `open` \| `converted` \| `lost`                                                   |
| `interest`              | text        | NULL |                                                                                              |
| `tags`                  | text[]      | NN   | `'{}'`                                                                                       |
| `notes`                 | text        | NULL |                                                                                              |
| `converted_customer_id` | uuid        | NULL | FK → `customers.id`                                                                          |
| `metadata`              | jsonb       | NN   | `'{}'`                                                                                       |
| `deleted_at`            | timestamptz | NULL | soft delete                                                                                  |

Indexes: `(tenant_id, owner_member_id, status)`, `(tenant_id, stage)`, `(tenant_id, email)`.

### 4.12 `customers`

| Column            | Type        | Null | Default / Constraint                                                                                 |
| ----------------- | ----------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `tenant_id`       | uuid        | NN   | FK → `tenants.id`                                                                                    |
| `owner_member_id` | uuid        | NN   | FK → `members.id`                                                                                    |
| `lead_id`         | uuid        | NULL | FK → `leads.id` — origin lead                                                                        |
| `member_id`       | uuid        | NULL | FK → `members.id` — set if the customer later becomes a member (journey: Customer → Member, spec §3) |
| `name`            | text        | NN   |                                                                                                      |
| `email`           | citext      | NULL |                                                                                                      |
| `phone`           | text        | NULL |                                                                                                      |
| `status`          | text        | NN   | `'active'` — `active` \| `inactive` \| `member`                                                      |
| `tags`            | text[]      | NN   | `'{}'`                                                                                               |
| `converted_at`    | timestamptz | NN   | `now()` — emits `CustomerConverted`                                                                  |
| `metadata`        | jsonb       | NN   | `'{}'`                                                                                               |
| `deleted_at`      | timestamptz | NULL | soft delete                                                                                          |

Indexes: `(tenant_id, owner_member_id, status)`, `(tenant_id, member_id) WHERE member_id IS NOT NULL`.

### 4.13 `follow_ups`

| Column            | Type        | Null | Default / Constraint                           |
| ----------------- | ----------- | ---- | ---------------------------------------------- |
| `tenant_id`       | uuid        | NN   | FK → `tenants.id`                              |
| `owner_member_id` | uuid        | NN   | FK → `members.id`                              |
| `lead_id`         | uuid        | NULL | FK → `leads.id`                                |
| `customer_id`     | uuid        | NULL | FK → `customers.id`                            |
| `title`           | text        | NN   |                                                |
| `note`            | text        | NULL |                                                |
| `due_at`          | timestamptz | NN   |                                                |
| `status`          | text        | NN   | `'pending'` — `pending` \| `done` \| `skipped` |
| `completed_at`    | timestamptz | NULL |                                                |
| `metadata`        | jsonb       | NN   | `'{}'`                                         |
| `deleted_at`      | timestamptz | NULL | soft delete                                    |

Constraints: `CHECK (lead_id IS NOT NULL OR customer_id IS NOT NULL)`. Indexes: `(tenant_id, owner_member_id, status, due_at)`, `(tenant_id, lead_id)`, `(tenant_id, customer_id)`.

### 4.14 `interactions`

| Column             | Type        | Null | Default / Constraint                                         |
| ------------------ | ----------- | ---- | ------------------------------------------------------------ |
| `tenant_id`        | uuid        | NN   | FK → `tenants.id`                                            |
| `member_id`        | uuid        | NN   | FK → `members.id` — acting member                            |
| `lead_id`          | uuid        | NULL | FK → `leads.id`                                              |
| `customer_id`      | uuid        | NULL | FK → `customers.id`                                          |
| `interaction_type` | text        | NN   | `call` \| `message` \| `meeting` \| `presentation` \| `note` |
| `channel`          | text        | NULL | `line` \| `phone` \| `email` \| `in_person` \| …             |
| `summary`          | text        | NULL |                                                              |
| `occurred_at`      | timestamptz | NN   | `now()`                                                      |
| `metadata`         | jsonb       | NN   | `'{}'`                                                       |

Constraints: `CHECK (lead_id IS NOT NULL OR customer_id IS NOT NULL)`. Indexes: `(tenant_id, lead_id, occurred_at)`, `(tenant_id, customer_id, occurred_at)`, `(tenant_id, member_id, occurred_at)`.

### 4.15 `notifications` · spec §52

| Column         | Type        | Null | Default / Constraint                                               |
| -------------- | ----------- | ---- | ------------------------------------------------------------------ |
| `tenant_id`    | uuid        | NN   | FK → `tenants.id`                                                  |
| `member_id`    | uuid        | NN   | FK → `members.id` — recipient                                      |
| `channel`      | text        | NN   | `in_app` \| `email` \| `push` \| `line` (`sms`, `whatsapp` future) |
| `category`     | text        | NN   | e.g. `membership`, `team`, `learning`, `crm`, `system`             |
| `template_key` | text        | NULL |                                                                    |
| `title`        | jsonb       | NN   | _(i18n)_                                                           |
| `body`         | jsonb       | NULL | _(i18n)_                                                           |
| `data`         | jsonb       | NN   | `'{}'` — deep-link payload                                         |
| `status`       | text        | NN   | `'pending'` — `pending` \| `sent` \| `failed` \| `read`            |
| `sent_at`      | timestamptz | NULL |                                                                    |
| `read_at`      | timestamptz | NULL |                                                                    |
| `deleted_at`   | timestamptz | NULL | soft delete (user clears inbox)                                    |

Indexes: `(tenant_id, member_id, status, created_at)`, `(tenant_id, status) WHERE status = 'pending'`.

### 4.16 `notification_preferences`

| Column      | Type    | Null | Default / Constraint |
| ----------- | ------- | ---- | -------------------- |
| `tenant_id` | uuid    | NN   | FK → `tenants.id`    |
| `member_id` | uuid    | NN   | FK → `members.id`    |
| `channel`   | text    | NN   |                      |
| `category`  | text    | NN   |                      |
| `enabled`   | boolean | NN   | `true`               |

Constraints: `UNIQUE(tenant_id, member_id, channel, category)`.

### 4.17 `ai_conversations` · spec §46–§48

| Column             | Type        | Null | Default / Constraint                                                 |
| ------------------ | ----------- | ---- | -------------------------------------------------------------------- |
| `tenant_id`        | uuid        | NN   | FK → `tenants.id`                                                    |
| `member_id`        | uuid        | NN   | FK → `members.id` — conversations are member-private (spec §50)      |
| `agent_type`       | text        | NN   | `assistant` (MVP) \| `healthy_living_coach` \| `business_coach` \| … |
| `title`            | text        | NULL |                                                                      |
| `status`           | text        | NN   | `'active'` — `active` \| `archived`                                  |
| `context_snapshot` | jsonb       | NN   | `'{}'` — resolved AI context refs (scope, entitlements) at creation  |
| `metadata`         | jsonb       | NN   | `'{}'`                                                               |
| `deleted_at`       | timestamptz | NULL | soft delete                                                          |

Indexes: `(tenant_id, member_id, status, updated_at)`.

### 4.18 `ai_messages`

| Column            | Type    | Null | Default / Constraint                        |
| ----------------- | ------- | ---- | ------------------------------------------- |
| `tenant_id`       | uuid    | NN   | FK → `tenants.id`                           |
| `conversation_id` | uuid    | NN   | FK → `ai_conversations.id`                  |
| `role`            | text    | NN   | `user` \| `assistant` \| `system` \| `tool` |
| `content`         | text    | NN   |                                             |
| `model`           | text    | NULL |                                             |
| `input_tokens`    | integer | NULL |                                             |
| `output_tokens`   | integer | NULL |                                             |
| `metadata`        | jsonb   | NN   | `'{}'`                                      |

Indexes: `(tenant_id, conversation_id, created_at)`.

### 4.19 `ai_usage` — metering (spec §53 AI usage/cost)

| Column            | Type          | Null | Default / Constraint                                       |
| ----------------- | ------------- | ---- | ---------------------------------------------------------- |
| `tenant_id`       | uuid          | NN   | FK → `tenants.id`                                          |
| `member_id`       | uuid          | NULL | FK → `members.id`; NULL for tenant-level jobs              |
| `conversation_id` | uuid          | NULL | FK → `ai_conversations.id`                                 |
| `provider`        | text          | NN   | `openai` \| `anthropic` \| `gemini` \| …                   |
| `model`           | text          | NN   |                                                            |
| `operation`       | text          | NN   | `chat` \| `summarize` \| `recommend` \| …                  |
| `input_tokens`    | integer       | NN   | `0`                                                        |
| `output_tokens`   | integer       | NN   | `0`                                                        |
| `cost`            | numeric(12,6) | NN   | `0` — provider cost in `currency` (6 dp: sub-cent pricing) |
| `currency`        | char(3)       | NN   | `'USD'`                                                    |
| `occurred_at`     | timestamptz   | NN   | `now()`                                                    |

Indexes: `(tenant_id, occurred_at)`, `(tenant_id, member_id, occurred_at)` — power per-tenant quota caps and platform AI cost dashboards.

---

## 5. Cross-Cutting Physical Design Notes

- **RLS coverage**: every table in §3–§4 except `tenants`, `users`, `entitlements`, `permissions` has the §1.5 policy (with the documented `roles`/`role_permissions` NULL-tenant variant; `audit_logs`/`domain_events` allow `tenant_id IS NULL` rows visible only to the platform role).
- **Migrations**: Prisma Migrate; RLS policies, partial unique indexes, and `CHECK` constraints are added via `migration.sql` customization (Prisma cannot express them natively). Never edit applied migrations.
- **Index discipline**: every FK used in joins gets an index; every hot list query has a covering composite index leading with `tenant_id`. Verify with `EXPLAIN` against seeded multi-tenant data in CI.
- **Future dedicated-DB tenants** (spec §61): because every tenant-owned row carries `tenant_id` and no cross-tenant FKs exist outside platform tables, a large tenant can be extracted with `COPY ... WHERE tenant_id = X` without schema changes.

---

## 6. Phase 2/3 Entities — Schema Reserved, NOT Built in MVP

All remaining spec §66 entities. Names, ownership, and key relationships are reserved now so MVP naming never collides; **no tables are created in Sprint 1–2**.

| Reserved table                                                           | Spec entity                                       | Phase | Notes                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `mentor_relationships`                                                   | MentorRelationship                                | 3     | Mirror of `referral_relationships` shape (separate mentor graph, spec §17)                                 |
| `habits`, `habit_logs`                                                   | Habit                                             | 2     | Task/Activity OS (spec §26–§27)                                                                            |
| `certifications`, `member_certifications`                                | Certification                                     | 2     | Learning OS (spec §24)                                                                                     |
| `health_goals`, `health_profiles`                                        | HealthGoal, HealthProfile                         | 2     | Stronger privacy: dedicated permissions `health.*` (spec §59), consider column-level encryption            |
| `topics`, `ingredients`, `evidence_references`, `articles` + join tables | Topic, Ingredient, EvidenceReference, Article     | 2     | Knowledge Graph (spec §28–§29); support global/tenant/private scopes (`tenant_id NULL` = global knowledge) |
| `brands`, `products`, `product_ingredients`, `product_mappings`          | Brand, Product, ProductIngredient, ProductMapping | 2     | Product Intelligence, brand-neutral (spec §30–§31)                                                         |
| `opportunities`                                                          | Opportunity                                       | 2     | CRM expansion (spec §34)                                                                                   |
| `communities`, `groups`, `posts`, `comments`, `reactions`                | Community, Group, Post, Comment, Reaction         | 2     | Community OS (spec §36)                                                                                    |
| `orders`, `order_items`, `subscriptions`                                 | Order, OrderItem, Subscription                    | 2     | Commerce OS + recurring engine (spec §39–§40)                                                              |
| `rank_definitions`, `rank_history`                                       | RankDefinition, RankHistory                       | 3     | Rank Engine (spec §44)                                                                                     |
| `compensation_plans`, `commissions`                                      | CompensationPlan, Commission                      | 3     | Compensation OS — optional, configurable, **separate graph** (spec §42)                                    |
| `rewards`, `achievements`                                                | Reward, Achievement                               | 3     | Reward OS / Gamification (spec §38, §45)                                                                   |
| `automations`, `automation_runs`                                         | Automation                                        | 3     | Trigger-action workflows (spec §51); MVP handles a few flows in code via domain events                     |

All reserved tables will follow every convention in §1 (uuid v7, `tenant_id`, timestamptz, RLS, tenant-scoped uniques, effective-date history).
