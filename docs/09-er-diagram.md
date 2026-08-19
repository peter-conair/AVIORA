# 09 — ER Diagrams

> AVIORA — Multi-Tenant Membership, Healthy Living & Growth Operating System
> Status: Approved for MVP · Last updated: 2026-08-19
> Companion to [08-data-model.md](./08-data-model.md) (authoritative column definitions) and [04-membership-model.md](./04-membership-model.md).

One giant diagram is unreadable, so the MVP schema is split into five focused views. Conventions in all diagrams:

- Table names are physical (snake_case). PK = primary key, FK = foreign key, UK = unique constraint (tenant-scoped unless noted).
- Every tenant-owned table has `tenant_id` FK → `tenants` — drawn explicitly only in Diagram A to avoid clutter; assume it everywhere else.
- `id` is always `uuid` (v7); `created_at`/`updated_at timestamptz` exist on every table (omitted from diagrams except where structurally interesting).
- `||--o{` = one-to-many, `||--||` = one-to-one, `}o--o{` via join tables only.

---

## A. Identity & Tenancy

User is global; Member is per-tenant; TenantMembership links them (spec §7). Roles/permissions are RBAC with scope (spec §19, §57).

```mermaid
erDiagram
    tenants ||--o{ tenant_settings : "has"
    tenants ||--o{ tenant_features : "has"
    tenants ||--o{ tenant_memberships : "has"
    tenants ||--o{ members : "has"
    tenants ||--o{ lifecycle_stages : "configures"
    tenants ||--o{ invitations : "issues"
    tenants ||--o{ roles : "defines custom (tenant_id nullable)"

    users ||--o{ tenant_memberships : "joins tenants via"
    users ||--o{ members : "is person behind"
    users ||--o{ invitations : "invited_by"

    members ||--|| member_profiles : "has profile"
    members }o--|| lifecycle_stages : "at stage"
    members ||--o{ member_roles : "granted"

    roles ||--o{ member_roles : "assigned as"
    roles ||--o{ role_permissions : "grants"
    permissions ||--o{ role_permissions : "granted via"

    tenants {
        uuid id PK
        text code UK "globally unique"
        text slug UK "subdomain"
        text name
        text tenant_type
        text status
        char(2) country
        text timezone
        char(2) default_language
        char(3) default_currency
        jsonb branding
        jsonb settings
        jsonb feature_flags
    }
    users {
        uuid id PK
        citext email UK "globally unique"
        text name
        text password_hash "nullable (SSO)"
        text status
        text platform_role "nullable"
        boolean mfa_enabled
    }
    tenant_memberships {
        uuid id PK
        uuid tenant_id FK
        uuid user_id FK
        text status "invited|active|suspended|left"
        boolean is_owner
        text_arr roles
        timestamptz joined_at
        timestamptz left_at "nullable - history kept"
    }
    members {
        uuid id PK
        uuid tenant_id FK
        uuid user_id FK
        text member_code UK "UNIQUE(tenant_id, member_code)"
        text display_name
        text status
        uuid lifecycle_stage_id FK "nullable"
        jsonb custom_fields
        timestamptz deleted_at "soft delete"
    }
    member_profiles {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK "UNIQUE - 1:1"
        date birth_date
        jsonb address
        jsonb social_links
        jsonb preferences
    }
    lifecycle_stages {
        uuid id PK
        uuid tenant_id FK
        text code UK "UNIQUE(tenant_id, code)"
        jsonb name "i18n"
        int sort_order
        jsonb requirements
    }
    roles {
        uuid id PK
        uuid tenant_id FK "NULL = platform system role"
        text code UK "UNIQUE(tenant_id, code)"
        jsonb name "i18n"
        boolean is_system
    }
    permissions {
        uuid id PK
        text key UK "dot notation, platform catalog"
        text default_scope "SELF..TENANT_ALL"
        text category
    }
    role_permissions {
        uuid id PK
        uuid role_id FK
        uuid permission_id FK
        text scope "SELF|DIRECT_TEAM|DESCENDANT_TEAMS|SPECIFIC_TEAMS|TENANT_ALL"
        jsonb scope_config
    }
    member_roles {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK
        uuid role_id FK
        timestamptz effective_from
        timestamptz effective_to "NULL = current"
    }
    tenant_settings {
        uuid id PK
        uuid tenant_id FK
        text key UK "UNIQUE(tenant_id, key)"
        jsonb value
    }
    tenant_features {
        uuid id PK
        uuid tenant_id FK
        text feature_key UK "UNIQUE(tenant_id, feature_key)"
        boolean enabled
        jsonb config
    }
    invitations {
        uuid id PK
        uuid tenant_id FK
        citext email
        text token_hash UK
        uuid role_id FK "nullable"
        uuid team_id FK "nullable"
        uuid membership_plan_id FK "nullable"
        text status
        timestamptz expires_at
    }
```

---

## B. Membership & Entitlements

Plan → plan_entitlements → entitlement catalog → capability checks (spec §8–§9, doc 04). `entitlements` is a platform catalog (no `tenant_id`); everything else is tenant-owned.

```mermaid
erDiagram
    members ||--o{ memberships : "holds (max 1 open)"
    membership_plans ||--o{ memberships : "instantiated as"
    membership_plans ||--o{ plan_entitlements : "maps"
    entitlements ||--o{ plan_entitlements : "mapped via"

    membership_plans {
        uuid id PK
        uuid tenant_id FK
        text code UK "UNIQUE(tenant_id, code)"
        jsonb name "i18n"
        text membership_type
        numeric(12_2) price
        char(3) currency
        text billing_cycle "free|one_time|monthly|quarterly|yearly|lifetime|custom"
        int trial_days
        jsonb benefits "display only"
        jsonb features
        jsonb limits
        jsonb eligibility_rules
        text status "draft|active|archived"
    }
    memberships {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK "partial UK: one open per member"
        uuid plan_id FK
        text status "draft|active|past_due|expired|cancelled"
        text billing_cycle "snapshot"
        numeric(12_2) price "snapshot"
        char(3) currency "snapshot"
        timestamptz started_at
        timestamptz trial_ends_at "nullable"
        timestamptz current_period_start
        timestamptz current_period_end
        timestamptz expires_at
        timestamptz cancelled_at
        boolean auto_renew
    }
    entitlements {
        uuid id PK
        text key UK "dot notation: ai.coach, team.create"
        jsonb name "i18n"
        text value_type "boolean|limit|enum"
        text category
        boolean is_active
    }
    plan_entitlements {
        uuid id PK
        uuid tenant_id FK
        uuid plan_id FK
        uuid entitlement_id FK
        jsonb value "true / limit object / enum level"
    }
    members {
        uuid id PK
        uuid tenant_id FK
        text member_code
    }
```

---

## C. Team & Relationship Graphs

Team tree (`parent_team_id` + closure table) and the referral graph are **separate structures — never coupled** (spec §15, §17–§18). All relationship rows are effective-dated; history is never destroyed (spec §16).

```mermaid
erDiagram
    teams ||--o{ teams : "parent_team_id (NULL = root)"
    teams ||--o{ team_closure : "as ancestor"
    teams ||--o{ team_closure : "as descendant"
    teams ||--o{ team_memberships : "has members via"
    teams ||--o{ team_leaderships : "led via"
    members ||--o{ team_memberships : "belongs to many teams"
    members ||--o{ team_leaderships : "leads"
    members ||--o{ referral_relationships : "as referrer"
    members ||--o{ referral_relationships : "as referred"
    roles ||--o{ team_memberships : "role within team"

    teams {
        uuid id PK
        uuid tenant_id FK
        uuid parent_team_id FK "self-FK, nullable"
        text team_type
        text code UK "UNIQUE(tenant_id, code)"
        text name
        text slug UK "UNIQUE(tenant_id, slug)"
        text status "active|archived - never deleted"
        uuid primary_leader_id FK "denormalized"
        text visibility
        jsonb settings
    }
    team_closure {
        uuid ancestor_team_id PK "composite PK"
        uuid descendant_team_id PK "composite PK"
        uuid tenant_id FK
        int depth "0 = self"
    }
    team_memberships {
        uuid id PK
        uuid tenant_id FK
        uuid team_id FK
        uuid member_id FK
        uuid role_id FK "nullable"
        text membership_type
        text status "active|left|transferred"
        timestamptz joined_at
        timestamptz left_at "NULL = current; partial UK when NULL"
    }
    team_leaderships {
        uuid id PK
        uuid tenant_id FK
        uuid team_id FK
        uuid member_id FK
        text leadership_role "primary_leader|co_leader|manager|coach|mentor"
        boolean is_primary "one current primary per team"
        text status
        timestamptz effective_from
        timestamptz effective_to "NULL = current"
    }
    referral_relationships {
        uuid id PK
        uuid tenant_id FK
        uuid referrer_member_id FK
        uuid referred_member_id FK "CHECK <> referrer"
        text relationship_type "referral|sponsor|introducer|affiliate|mentor_referral"
        timestamptz effective_from
        timestamptz effective_to "NULL = current"
        jsonb metadata
    }
    members {
        uuid id PK
        uuid tenant_id FK
        text member_code
    }
    roles {
        uuid id PK
        text code
    }
```

---

## D. Growth, Learning & CRM

Dreams/Goals (spec §22), Learning OS (spec §24), and member-owned CRM (spec §34). CRM records belong to an **owner member** (the member working the lead), scoped by team permissions at query time.

```mermaid
erDiagram
    members ||--o{ dreams : "envisions"
    members ||--o{ goals : "sets"
    dreams ||--o{ goals : "realized by (nullable FK)"
    teams ||--o{ goals : "team goals (nullable FK)"

    courses ||--o{ lessons : "contains"
    members ||--o{ learning_progress : "tracks"
    courses ||--o{ learning_progress : "measured for"
    lessons ||--o{ learning_progress : "per-lesson rows (nullable FK)"

    members ||--o{ leads : "owns"
    members ||--o{ customers : "owns"
    leads |o--o| customers : "converts to"
    leads ||--o{ follow_ups : "scheduled for"
    customers ||--o{ follow_ups : "scheduled for"
    leads ||--o{ interactions : "logged against"
    customers ||--o{ interactions : "logged against"
    members ||--o{ interactions : "performed by"

    dreams {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK
        text title
        text category
        text image_url "vision board"
        date target_date
        text status "dreaming|in_progress|achieved"
        timestamptz deleted_at "soft delete"
    }
    goals {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK
        uuid team_id FK "nullable"
        uuid dream_id FK "nullable"
        text goal_type "life|health|business|annual|..."
        text title
        numeric(12_2) target_value
        numeric(12_2) current_value
        date due_date
        text status "active|completed|paused|abandoned"
        timestamptz completed_at
    }
    courses {
        uuid id PK
        uuid tenant_id FK
        text code UK "UNIQUE(tenant_id, code)"
        jsonb title "i18n"
        text status "draft|published|archived"
        jsonb assignment_rules
    }
    lessons {
        uuid id PK
        uuid tenant_id FK
        uuid course_id FK
        jsonb title "i18n"
        text content_type "video|audio|document|text|quiz"
        text content_url "R2 tenant path"
        int sort_order UK "UNIQUE(tenant_id, course_id, sort_order)"
    }
    learning_progress {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK
        uuid course_id FK
        uuid lesson_id FK "NULL = course summary row"
        text status "not_started|in_progress|completed"
        numeric(5_2) progress_pct
        timestamptz completed_at
    }
    leads {
        uuid id PK
        uuid tenant_id FK
        uuid owner_member_id FK
        text name
        citext email
        text stage "tenant-configurable pipeline"
        text status "open|converted|lost"
        uuid converted_customer_id FK "nullable"
        timestamptz deleted_at "soft delete"
    }
    customers {
        uuid id PK
        uuid tenant_id FK
        uuid owner_member_id FK
        uuid lead_id FK "nullable origin"
        uuid member_id FK "nullable - became member"
        text name
        text status "active|inactive|member"
        timestamptz converted_at
    }
    follow_ups {
        uuid id PK
        uuid tenant_id FK
        uuid owner_member_id FK
        uuid lead_id FK "nullable"
        uuid customer_id FK "nullable - CHECK one set"
        timestamptz due_at
        text status "pending|done|skipped"
        timestamptz completed_at
    }
    interactions {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK "actor"
        uuid lead_id FK "nullable"
        uuid customer_id FK "nullable - CHECK one set"
        text interaction_type "call|message|meeting|presentation|note"
        text channel
        timestamptz occurred_at
    }
    members {
        uuid id PK
        uuid tenant_id FK
    }
    teams {
        uuid id PK
        uuid tenant_id FK
    }
```

---

## E. Platform Services

Notifications (spec §52), AI OS (spec §46–§48, member-private conversations), audit (spec §60), and the transactional outbox (spec §64–§65). `audit_logs` and `domain_events` reference aggregates polymorphically (`entity_type`/`aggregate_type` + id), so no hard FKs to business tables.

```mermaid
erDiagram
    members ||--o{ notifications : "receives"
    members ||--o{ notification_preferences : "configures"
    members ||--o{ ai_conversations : "owns (private)"
    ai_conversations ||--o{ ai_messages : "contains"
    ai_conversations ||--o{ ai_usage : "metered by (nullable FK)"
    members ||--o{ ai_usage : "attributed to (nullable FK)"
    users ||--o{ audit_logs : "acted in"
    users ||--o{ domain_events : "actor_user_id (nullable)"
    tenants ||--o{ audit_logs : "scoped (nullable - platform rows)"
    tenants ||--o{ domain_events : "scoped (nullable - platform rows)"

    notifications {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK "recipient"
        text channel "in_app|email|push|line"
        text category
        jsonb title "i18n"
        jsonb data "deep-link payload"
        text status "pending|sent|failed|read"
        timestamptz sent_at
        timestamptz read_at
    }
    notification_preferences {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK
        text channel UK "UNIQUE(tenant_id, member_id, channel, category)"
        text category
        boolean enabled
    }
    ai_conversations {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK
        text agent_type "assistant|healthy_living_coach|..."
        text title
        text status "active|archived"
        jsonb context_snapshot
    }
    ai_messages {
        uuid id PK
        uuid tenant_id FK
        uuid conversation_id FK
        text role "user|assistant|system|tool"
        text content
        int input_tokens
        int output_tokens
    }
    ai_usage {
        uuid id PK
        uuid tenant_id FK
        uuid member_id FK "nullable"
        uuid conversation_id FK "nullable"
        text provider "openai|anthropic|gemini"
        text model
        text operation
        int input_tokens
        int output_tokens
        numeric(12_6) cost
        char(3) currency
        timestamptz occurred_at
    }
    audit_logs {
        uuid id PK
        uuid tenant_id FK "nullable - platform actions"
        uuid user_id FK "nullable actor"
        uuid member_id FK "nullable actor context"
        text action
        text entity_type "polymorphic"
        uuid entity_id
        jsonb before
        jsonb after
        inet ip
        text user_agent
        uuid request_id
        timestamptz created_at "append-only"
    }
    domain_events {
        uuid id PK
        text event_name "MembershipActivated, TeamCreated, ..."
        uuid tenant_id FK "nullable"
        text aggregate_type "polymorphic"
        uuid aggregate_id
        uuid actor_user_id FK "nullable"
        jsonb payload
        timestamptz occurred_at
        timestamptz processed_at "NULL = pending (outbox)"
        int attempts
    }
    members {
        uuid id PK
        uuid tenant_id FK
    }
    users {
        uuid id PK
        citext email
    }
    tenants {
        uuid id PK
        text slug
    }
```

---

## Reading Guide

| If you're working on…                                | Start with diagram | Then read                                           |
| ---------------------------------------------------- | ------------------ | --------------------------------------------------- |
| Auth, tenant switcher, onboarding, RBAC              | A                  | 08 §3.1–3.9, 3.14–3.17                              |
| Plans, activation, entitlement gates                 | B                  | 04 (full), 08 §3.10–3.13                            |
| Team hierarchy, move/merge, leader scopes, referrals | C                  | 08 §4.1–4.5, 05-team-architecture.md                |
| Goals, courses, CRM pipeline                         | D                  | 08 §4.6–4.14                                        |
| Notifications, AI assistant, audit, event outbox     | E                  | 08 §3.18–3.19, §4.15–4.19, 11-event-architecture.md |
