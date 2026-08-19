# 04 — Membership Model

> AVIORA — Multi-Tenant Membership, Healthy Living & Growth Operating System
> Status: Approved for MVP · Last updated: 2026-08-19
> Spec references: §8 (Membership Domain), §9 (Entitlements), §10 (Member 360), §61 (Database), §66 (Core Entities)

Membership is the **center of the platform** (spec Final Instruction: "Membership is the center"). This document defines the membership domain: plans, the member's plan instance, entitlements, runtime resolution, tenant-custom plans, and membership domain events.

---

## 1. Domain Overview

```text
MembershipPlan  (tenant-configured product: "what can be bought/granted")
      │ 1..*
      ▼
Membership      (a member's instance of a plan, with lifecycle + billing state)
      │
      ▼
PlanEntitlement (plan → entitlement mapping, with per-plan limits)
      │
      ▼
Entitlement     (platform capability catalog, dot-notation keys)
      │
      ▼
Capability checks at runtime (guards, UI feature gates, AI context)
```

Design rules (from spec §8–§9):

1. **Never hard-code functionality into membership names.** "Premium" means nothing to the code; only entitlement keys do.
2. **Tenant Admin can create custom plans** without schema changes or deployments.
3. Membership is **per member, per tenant** — a User may hold different memberships in different tenants through separate Member records.
4. Every business rule (price, trial, benefits, eligibility) is **data, not code**.

---

## 2. MembershipPlan

A tenant-owned catalog entry describing a purchasable/grantable membership. Fields follow spec §8 exactly.

| Field                       | Type          | Notes                                                                                                                             |
| --------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | uuid (v7)     | PK, app-generated                                                                                                                 |
| `tenant_id`                 | uuid          | FK → `tenants.id`, NOT NULL                                                                                                       |
| `code`                      | text          | Stable machine code, `UNIQUE(tenant_id, code)`, e.g. `premium-annual`                                                             |
| `name`                      | jsonb         | i18n map, e.g. `{"th": "พรีเมียม", "en": "Premium"}`                                                                              |
| `description`               | jsonb         | i18n map, nullable                                                                                                                |
| `membership_type`           | text          | One of the supported models below; free-form per tenant                                                                           |
| `price`                     | numeric(12,2) | `0.00` for free plans                                                                                                             |
| `currency`                  | char(3)       | ISO 4217, defaults to tenant `default_currency`                                                                                   |
| `billing_cycle`             | text          | `free` \| `one_time` \| `monthly` \| `quarterly` \| `yearly` \| `lifetime` \| `custom`                                            |
| `trial_days`                | integer       | Default `0`; `> 0` enables trial handling (see §4.2)                                                                              |
| `benefits`                  | jsonb         | Display-oriented benefit list (i18n), marketing copy — **not** used for authorization                                             |
| `features`                  | jsonb         | Structured feature descriptors for UI rendering                                                                                   |
| `limits`                    | jsonb         | Plan-level quantitative limits, e.g. `{"team.max": 5, "ai.messages_per_day": 50}`                                                 |
| `eligibility_rules`         | jsonb         | Declarative rules evaluated at purchase/assignment (e.g. `{"requires_invitation": true, "min_lifecycle_stage": "active_member"}`) |
| `status`                    | text          | `draft` \| `active` \| `archived`                                                                                                 |
| `metadata`                  | jsonb         | Tenant extension bag                                                                                                              |
| `created_at` / `updated_at` | timestamptz   | Standard                                                                                                                          |

### Supported membership types (spec §8)

`Free`, `Basic`, `Premium`, `VIP`, `Partner`, `Business`, `Coach`, `Leader`, `Corporate`, `Invitation Only`, `Lifetime`, `Custom` — these are **suggested values**, not an enum enforced by the database. `membership_type` is informational/reporting; authorization comes exclusively from entitlements.

### Plan lifecycle

- `draft` — being configured; not purchasable, not assignable.
- `active` — available.
- `archived` — no new memberships may be created on it, but **existing memberships keep working** until they expire. Plans are never deleted (history preservation, spec §16 principle applied platform-wide).

---

## 3. Membership (the member's active plan instance)

One row per plan instance held by a member. A member has **at most one open membership** (status in `draft`/`active`/`past_due`) at a time in MVP; historical rows are kept forever.

Key fields (full DDL in [08-data-model.md](./08-data-model.md)):

- `tenant_id`, `member_id` (FK → `members`), `plan_id` (FK → `membership_plans`)
- `status` — see lifecycle below
- `billing_cycle`, `price`, `currency` — **snapshot** of the plan at activation time, so later plan edits never mutate existing agreements
- `started_at`, `trial_ends_at`, `current_period_start`, `current_period_end`, `expires_at`, `cancelled_at`
- `auto_renew` boolean, `cancel_reason`, `metadata`

### 3.1 Status lifecycle

```text
            activate                    payment fails
  draft ───────────────► active ───────────────────────► past_due
                            │  ▲                             │
                            │  └────── payment recovered ────┤
              member/admin  │                                │ grace period ends
              cancels       │                                ▼
                            ▼                             expired
                        cancelled
```

| Status      | Meaning                                                                                                 | Entitlements active?                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `draft`     | Created but not yet activated (awaiting payment, approval, or invitation acceptance)                    | No                                                                                      |
| `active`    | In good standing (includes trial period — see §4.2)                                                     | **Yes**                                                                                 |
| `past_due`  | Renewal payment failed; inside grace period (tenant-configurable, default 7 days via `tenant_settings`) | Yes (degradable per tenant policy)                                                      |
| `expired`   | Period ended without renewal, or grace period elapsed                                                   | No                                                                                      |
| `cancelled` | Explicitly terminated by member or admin; `cancelled_at` + `cancel_reason` recorded                     | No (or until `current_period_end`, per tenant policy `membership.cancel_at_period_end`) |

Allowed transitions: `draft→active`, `draft→cancelled`, `active→past_due`, `active→expired`, `active→cancelled`, `past_due→active`, `past_due→expired`, `past_due→cancelled`. All transitions are executed in the membership service (single writer), emit a domain event, and are audit-logged. **No row is ever deleted**; renewal creates/extends periods on the same row, plan changes close the old row (`expired` or `cancelled`) and open a new one.

### 3.2 Trial handling

- If `plan.trial_days > 0`, activation sets `trial_ends_at = started_at + trial_days` and the membership is `active` immediately (trial is a **phase of `active`**, not a separate status — keeps guards simple).
- Runtime can distinguish trials with `is_trialing = status = 'active' AND now() < trial_ends_at` (exposed as a computed flag in the API, usable for UI badges and tenant automation triggers).
- At `trial_ends_at`: if payment succeeds (or the plan is free) the membership continues `active` with a normal billing period; if payment fails → `past_due`; if no payment method and the plan is paid → `expired`.
- One trial per member per plan: enforced in service logic against the member's membership history.

### 3.3 Billing cycle

`billing_cycle` drives `current_period_start`/`current_period_end` computation:

| Cycle                              | Period behavior                                                            |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `free`                             | No periods; `expires_at` NULL (runs until cancelled)                       |
| `one_time` / `lifetime`            | Single period; `expires_at` NULL                                           |
| `monthly` / `quarterly` / `yearly` | Rolling periods; renewal advances the period and emits `MembershipRenewed` |
| `custom`                           | Interval read from `plan.limits` → `{"billing.interval_days": N}`          |

Payment integration is **Phase 2** (Commerce OS). MVP supports free plans, admin-granted plans, and manually-recorded payments; the schema above is already payment-provider-ready.

---

## 4. Entitlements (spec §9)

### 4.1 Entitlement catalog

`entitlements` is a **platform-level catalog** (pure-platform config, RLS-exempt) of capability keys in dot notation:

```text
course.access
ai.coach
community.private
marketplace.access
business.crm
team.create
team.manage
analytics.team
product.discount
event.vip
mentor.access
```

| Field         | Type      | Notes                                                                         |
| ------------- | --------- | ----------------------------------------------------------------------------- |
| `id`          | uuid (v7) | PK                                                                            |
| `key`         | text      | `UNIQUE`, dot notation, lowercase — `<domain>.<capability>[.<sub>]`           |
| `name`        | jsonb     | i18n display name                                                             |
| `description` | jsonb     | i18n, nullable                                                                |
| `value_type`  | text      | `boolean` \| `limit` \| `enum` — how `plan_entitlements.value` is interpreted |
| `category`    | text      | Grouping for the admin UI (`learning`, `ai`, `team`, `crm`, …)                |
| `is_active`   | boolean   | Retired keys are deactivated, never deleted                                   |

New capabilities are added by inserting a catalog row + wiring one guard — **never** by checking plan names or types anywhere in code.

### 4.2 PlanEntitlement mapping

`plan_entitlements` is the tenant-owned join between a plan and the catalog:

| Field            | Type  | Notes                                                                                      |
| ---------------- | ----- | ------------------------------------------------------------------------------------------ |
| `tenant_id`      | uuid  | NOT NULL (matches the plan's tenant)                                                       |
| `plan_id`        | uuid  | FK → `membership_plans.id`                                                                 |
| `entitlement_id` | uuid  | FK → `entitlements.id`                                                                     |
| `value`          | jsonb | Interpreted per `value_type`: `true`, `{"limit": 50, "period": "day"}`, `{"level": "vip"}` |
| —                | —     | `UNIQUE(tenant_id, plan_id, entitlement_id)`                                               |

```text
Membership Plan ──► PlanEntitlements ──► Entitlement keys ──► Platform capabilities
```

### 4.3 Runtime entitlement resolution

Resolution happens once per request context and is cached:

```text
request (TenantContext + MemberContext)
   │
   ├─ 1. Load member's open membership (status active | past_due)
   ├─ 2. Load plan_entitlements for its plan_id
   ├─ 3. Materialize EntitlementSet: { "ai.coach": true, "ai.messages_per_day": 50, ... }
   ├─ 4. Cache in Redis
   │       key:  ent:{tenant_id}:{member_id}
   │       TTL:  300s
   └─ 5. Guards / services / AI Gateway check the set:
          @RequireEntitlement('business.crm')
          entitlements.has('team.create')
          entitlements.limit('ai.messages_per_day')
```

**Invalidation**: any membership status transition, plan change, or `plan_entitlements` edit deletes `ent:{tenant_id}:{member_id}` (or `ent:{tenant_id}:*` on plan-level edits) inside the same transaction boundary via the outbox consumer. TTL is the safety net, explicit invalidation is the mechanism.

**Layering with RBAC**: entitlements answer _"does the member's plan include this capability?"_; roles/permissions (doc 07) answer _"is this person allowed to perform this action at this scope?"_. A request must pass **both** gates. AI Gateway receives the resolved EntitlementSet as part of AI Context (spec §47) and must respect it.

---

## 5. Custom plans per tenant

Tenant Admin plan builder (no code involved):

1. Create plan (`draft`) → set code, i18n name, type, price/cycle/trial.
2. Attach entitlements from the catalog, setting `value` per key (toggle, limit, level).
3. Set `limits` and `eligibility_rules` (e.g. invitation-only, lifecycle-stage minimum).
4. Activate. Optionally archive later — existing members are unaffected until natural expiry.

Because entitlements are the only authorization currency, two tenants can both have a plan named "VIP" with completely different capabilities, and a tenant can invent "Sunrise Founder Circle" without any platform change (spec: never hard-code a membership structure).

---

## 6. Membership domain events

Published through the transactional outbox (`domain_events`, see doc 08 §5) with `aggregate_type = 'membership'`:

| Event                 | Emitted when                                                                                      | Typical consumers                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `MembershipActivated` | `draft→active` (incl. trial start)                                                                | Onboarding journey start, welcome notification, entitlement cache warm-up, analytics |
| `MembershipRenewed`   | Billing period advanced                                                                           | Receipts, analytics                                                                  |
| `MembershipPastDue`   | `active→past_due`                                                                                 | Dunning notification, admin alert                                                    |
| `MembershipExpiring`  | Scheduled scan: `current_period_end`/`trial_ends_at` within N days (tenant-configurable: 7, 3, 1) | Renewal reminder automations (spec §51 trigger `membership.expiring`)                |
| `MembershipExpired`   | `→expired`                                                                                        | Entitlement cache invalidation, downgrade flows, win-back automation                 |
| `MembershipCancelled` | `→cancelled`                                                                                      | Cancellation survey, audit, churn analytics                                          |

Payload convention:

```json
{
  "event_name": "MembershipActivated",
  "tenant_id": "0198f3c2-…",
  "aggregate_type": "membership",
  "aggregate_id": "0198f3c9-…",
  "payload": {
    "member_id": "0198f3c5-…",
    "plan_id": "0198f3c1-…",
    "plan_code": "premium-annual",
    "status": "active",
    "is_trialing": true,
    "trial_ends_at": "2026-09-02T00:00:00Z"
  },
  "occurred_at": "2026-08-19T04:12:33Z"
}
```

`MembershipExpiring` is produced by an idempotent daily scheduler (per tenant timezone) that records emitted reminder offsets in `memberships.metadata` to avoid duplicates.

---

## 7. Invariants & tests

- A member never has two open memberships (partial unique index, doc 08).
- Entitlement checks must fail **closed**: no membership row or cache miss + DB miss ⇒ no entitlement.
- Tenant A's plans/entitlement mappings are invisible to Tenant B (RLS + app filter — highest-priority test, spec §69).
- Status transitions outside the allowed graph are rejected at the service layer.
- Plan snapshot fields on `memberships` never change after activation.
- Every transition writes exactly one outbox event and one audit log entry in the same transaction.
