# 11 — Event Architecture

> **Project:** AVIORA · **Date:** 2026-08-19 · **Status:** Accepted
> Covers spec §64–65 (domain events, modular monolith seams) and the automation triggers of §51.
> Depends on: [00-architecture-assessment.md](./00-architecture-assessment.md), [03-multi-tenant-architecture.md](./03-multi-tenant-architecture.md)

Domain events are the **only** cross-module communication channel besides exported application services (doc 21 §5). They are also the extraction seam: if a module ever becomes a service, its event subscriptions become network subscriptions with no semantic change.

---

## 1. Principles

1. **Events are facts, past tense, PascalCase** — `MemberRegistered`, never `RegisterMember` (that's a command).
2. **Atomicity via transactional outbox** — the event row is written in the _same database transaction_ as the state change. No state change without its event; no event without its state change.
3. **At-least-once delivery, idempotent handlers** — the dispatcher may deliver twice; every handler must tolerate replay.
4. **Tenant-aware end to end** — every event carries `tenant_id`; workers rebuild TenantContext before touching data (doc 03 §3).
5. **Payloads are self-contained but minimal** — ids + the facts that changed. Handlers needing more data query the owning module's service (fat events rot; queries stay fresh).
6. **Versioned** — `version` per event name; additive changes preferred; breaking changes bump the version and handlers branch until old versions drain.

---

## 2. Event envelope

Canonical TypeScript type in `packages/shared` (single source for API and workers):

```ts
export interface DomainEvent<TPayload = unknown> {
  event_id: string; // uuid v7 — globally unique, time-ordered; idempotency key
  event_name: string; // PascalCase, e.g. "MemberJoinedTeam"
  version: number; // schema version of payload for this event_name (starts at 1)
  tenant_id: string | null; // null ONLY for platform-scope events (e.g. TenantCreated pre-context)
  aggregate_type: string; // e.g. "Member", "Team", "Goal"
  aggregate_id: string; // uuid of the aggregate the fact is about
  actor: {
    type: 'USER' | 'SYSTEM' | 'AI';
    user_id?: string; // when USER
    member_id?: string; // when acting inside a tenant
  };
  payload: TPayload; // event-specific facts (validated by zod schema per event_name)
  occurred_at: string; // ISO-8601 with offset (timestamptz semantics)
  correlation_id: string; // request_id of the originating request; propagated through chains
  causation_id: string | null; // event_id of the event that caused this one (null for root events)
}
```

Outbox table (platform-scope for the dispatcher's polling; rows still carry `tenant_id` for handler context and analytics):

```prisma
model DomainEventRecord {
  id            String    @id @db.Uuid                    // = event_id (uuid v7)
  eventName     String    @map("event_name")
  version       Int       @default(1)
  tenantId      String?   @map("tenant_id") @db.Uuid
  aggregateType String    @map("aggregate_type")
  aggregateId   String    @map("aggregate_id") @db.Uuid
  actor         Json
  payload       Json
  occurredAt    DateTime  @map("occurred_at") @db.Timestamptz(6)
  correlationId String    @map("correlation_id")
  causationId   String?   @map("causation_id") @db.Uuid
  dispatchedAt  DateTime? @map("dispatched_at") @db.Timestamptz(6)  // NULL = pending
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([dispatchedAt, createdAt])          // dispatcher poll: WHERE dispatched_at IS NULL
  @@index([tenantId, aggregateType, aggregateId, occurredAt]) // aggregate timeline / audit
  @@index([eventName, occurredAt])
  @@map("domain_events")
}
```

`domain_events` is append-only and doubles as an audit-grade event log and future replay/backfill source (e.g., re-deriving analytics snapshots).

---

## 3. Domain event catalog

### 3.1 Platform & tenant lifecycle

| Event                   | Aggregate | Key payload fields               | MVP |
| ----------------------- | --------- | -------------------------------- | --- |
| `TenantCreated`         | Tenant    | code, slug, tenant_type, country | ✅  |
| `TenantActivated`       | Tenant    | plan_id                          | ✅  |
| `TenantSuspended`       | Tenant    | reason                           | ✅  |
| `TenantSettingsChanged` | Tenant    | changed_keys                     | ✅  |

### 3.2 Identity & membership

| Event                         | Aggregate  | Key payload fields                             | MVP |
| ----------------------------- | ---------- | ---------------------------------------------- | --- |
| `UserRegistered`              | User       | email (hashed ref), locale                     | ✅  |
| `MemberRegistered`            | Member     | user_id, invited_by_member_id?, referral_code? | ✅  |
| `MemberProfileUpdated`        | Member     | changed_fields                                 | ✅  |
| `MembershipActivated`         | Membership | plan_id, billing_cycle, trial_ends_at?         | ✅  |
| `MembershipExpiring`          | Membership | expires_at, days_left                          | ✅  |
| `MembershipExpired`           | Membership | plan_id                                        | ✅  |
| `MembershipChanged`           | Membership | old_plan_id, new_plan_id                       | ✅  |
| `MemberLifecycleStageChanged` | Member     | old_stage, new_stage                           | ✅  |
| `MemberInactive`              | Member     | last_active_at, inactivity_days                | ✅  |

### 3.3 Team & organization

| Event              | Aggregate | Key payload fields                                                 | MVP               |
| ------------------ | --------- | ------------------------------------------------------------------ | ----------------- |
| `TeamCreated`      | Team      | parent_team_id?, team_type                                         | ✅                |
| `TeamMoved`        | Team      | old_parent_id?, new_parent_id?                                     | ✅                |
| `TeamMerged`       | Team      | source_team_id, target_team_id                                     | ✅                |
| `TeamArchived`     | Team      | —                                                                  | ✅                |
| `LeaderAssigned`   | Team      | member_id, leadership_role, is_primary, previous_leader_member_id? | ✅                |
| `MemberJoinedTeam` | Team      | member_id, membership_type                                         | ✅                |
| `MemberLeftTeam`   | Team      | member_id, reason (LEFT/TRANSFERRED/MERGED_OUT)                    | ✅                |
| `ReferralRecorded` | Member    | referrer_member_id, relationship_type                              | ✅ (capture only) |

### 3.4 Goals & growth

| Event                 | Aggregate | Key payload fields        | MVP     |
| --------------------- | --------- | ------------------------- | ------- |
| `GoalCreated`         | Goal      | category, target, due_at? | ✅      |
| `GoalProgressUpdated` | Goal      | progress_pct              | ✅      |
| `GoalCompleted`       | Goal      | category                  | ✅      |
| `DreamCreated`        | Dream     | category                  | ✅      |
| `HabitCheckedIn`      | Habit     | date, streak              | Phase 2 |

### 3.5 Learning

| Event                 | Aggregate        | Key payload fields                                              | MVP     |
| --------------------- | ---------------- | --------------------------------------------------------------- | ------- |
| `CourseAssigned`      | LearningProgress | course_id, member_id, assigned_by (TENANT/TEAM/ROLE/INDIVIDUAL) | ✅      |
| `CourseStarted`       | LearningProgress | course_id, member_id                                            | ✅      |
| `LessonCompleted`     | LearningProgress | course_id, lesson_id, member_id                                 | ✅      |
| `CourseCompleted`     | LearningProgress | course_id, member_id, score?                                    | ✅      |
| `CertificationIssued` | Certification    | course_id, member_id                                            | Phase 2 |

### 3.6 CRM

| Event               | Aggregate | Key payload fields       | MVP |
| ------------------- | --------- | ------------------------ | --- |
| `LeadCreated`       | Lead      | source, owner_member_id  | ✅  |
| `LeadStageChanged`  | Lead      | old_stage, new_stage     | ✅  |
| `LeadInactive`      | Lead      | last_interaction_at      | ✅  |
| `FollowUpScheduled` | FollowUp  | lead_id, due_at          | ✅  |
| `FollowUpCompleted` | FollowUp  | lead_id, outcome         | ✅  |
| `CustomerConverted` | Customer  | lead_id, owner_member_id | ✅  |

### 3.7 Commerce, rank, reward (Phase 2–3 — cataloged now so names are reserved)

`ProductPurchased`, `OrderCompleted`, `SubscriptionRenewed`, `SubscriptionFailed`, `RankAchieved`, `RankRequalified`, `RewardGranted`, `CommissionCalculated`, `ChallengeJoined`, `ChallengeCompleted`, `PostPublished`, `AchievementUnlocked`.

### 3.8 AI & audit

| Event                   | Aggregate      | Key payload fields                       | MVP |
| ----------------------- | -------------- | ---------------------------------------- | --- |
| `AIConversationStarted` | AIConversation | agent_key, member_id                     | ✅  |
| `AIUsageRecorded`       | AIUsage        | provider, model, tokens_in/out, cost_usd | ✅  |
| `NotificationSent`      | Notification   | channel, template_key, member_id         | ✅  |

Payload schemas live in `packages/shared/src/events/` as zod schemas keyed by `event_name` + `version`; both the publisher and handlers validate against them.

---

## 4. Transactional outbox — publish path

Application services never talk to BullMQ directly. They append events to the unit of work; the persistence wrapper writes state + events atomically.

```ts
// inside an application service (team module)
async moveTeam(ctx: TenantContext, cmd: MoveTeamCommand) {
  return this.uow.execute(ctx, async (tx, events) => {
    // ... adjacency update + closure rewrite (doc 05 §2.4) using tx ...
    events.publish('TeamMoved', {
      aggregate: { type: 'Team', id: cmd.teamId },
      payload: { old_parent_id: oldParent, new_parent_id: cmd.newParentId },
    });
  });
}
```

The `uow.execute` wrapper (packages/db):

1. Opens `prisma.$transaction`, sets `app.tenant_id` (doc 03 §4.1).
2. Runs the work.
3. Inserts collected events into `domain_events` **in the same transaction** (filling envelope fields from TenantContext: `tenant_id`, `actor`, `correlation_id`).
4. Commits. If the TX rolls back, events vanish with it — exactly right.

### Dispatcher (outbox relay)

A single relay process (runs inside the API deployment for MVP; extractable later):

```
loop every 500ms (and on LISTEN/NOTIFY wakeup):
  rows = SELECT * FROM domain_events
         WHERE dispatched_at IS NULL
         ORDER BY created_at
         LIMIT 100
         FOR UPDATE SKIP LOCKED;        -- safe with multiple relay instances
  for each row: enqueue BullMQ job (jobId = event_id) on queue "domain-events"
  UPDATE domain_events SET dispatched_at = now() WHERE id IN (...)  -- same TX as the SELECT
```

- `jobId = event_id` → BullMQ dedupes if the relay crashes between enqueue and update (at-least-once with cheap dedupe).
- A `NOTIFY domain_events_new` trigger keeps latency low without tight polling.
- Ordering: global ordering is **not** guaranteed (and not promised). Per-aggregate ordering is approximated by uuid v7 time-ordering + `occurred_at`; handlers that truly need ordering read the aggregate's current state instead of trusting sequence.

---

## 5. Subscription model — no cross-module imports

Modules subscribe declaratively. The events module owns the BullMQ worker; it fans each event out to all registered handlers. **No module imports another module's code to react to it** — the event name string + shared zod schema is the entire contract.

```ts
// modules/analytics/application/handlers/team-metrics.handler.ts
@EventsHandler('MemberJoinedTeam', 'MemberLeftTeam', 'GoalCompleted', 'CourseCompleted')
export class TeamMetricsDirtyMarker implements DomainEventHandler {
  async handle(event: DomainEvent, ctx: TenantContext) {
    await this.dirtySet.mark(ctx, teamIdFrom(event));
  }
}
```

Registration mechanics:

- `@EventsHandler(...names)` decorator + a `DiscoveryService` scan at boot builds the routing table `event_name → handler[]`.
- The worker wraps each handler call in `cls.run()` with a TenantContext rebuilt from the envelope (`tenant_id`, actor) — doc 03 §3.
- Each `(event, handler)` pair is tracked independently (see §6) so one failing handler doesn't block others.

Typical MVP subscriptions:

| Event                                 | Handlers (module)                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `TenantCreated`                       | seed roles (identity), default plans (membership), platform analytics (platform)                             |
| `MemberRegistered`                    | welcome notification (notification), audit (audit), lifecycle init (membership), platform metrics (platform) |
| `MembershipExpiring`                  | reminder notification (notification)                                                                         |
| `MemberJoinedTeam` / `MemberLeftTeam` | metrics dirty-mark (analytics), audit (audit), scope-cache invalidation (team)                               |
| `LeaderAssigned`                      | notification, audit, scope-cache invalidation (team)                                                         |
| `GoalCompleted`, `CourseCompleted`    | metrics (analytics), notification, audit                                                                     |
| `LeadInactive`                        | follow-up task suggestion (crm), notification                                                                |
| `AIUsageRecorded`                     | cost aggregation (platform)                                                                                  |

The Phase-3 automation engine (spec §51) becomes _one more subscriber_ that matches events against tenant-configured trigger-action rules — the event architecture needs no change to support it.

---

## 6. Idempotency, retry, DLQ

### Idempotency

Every handler execution is guarded by a processed-events ledger:

```sql
CREATE TABLE processed_events (
  event_id     uuid        NOT NULL,
  handler_name text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, handler_name)
);
```

The worker wrapper: `INSERT ... ON CONFLICT DO NOTHING` → if no row inserted, skip (already processed). Where the handler writes to the same DB, the ledger insert joins the handler's transaction → **exactly-once effects** for DB-writing handlers. Handlers with external side effects (email, LINE, AI calls) additionally use natural idempotency keys (e.g., notification dedupe key `event_id:template`) because the external call and ledger commit can't be atomic.

### Retry & DLQ (BullMQ)

```ts
defaultJobOptions: {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },   // 2s, 4s, 8s, 16s, 32s
  removeOnComplete: { age: 86400 },                 // keep 24h for inspection
  removeOnFail: false,
}
```

- Handler-level granularity: the fan-out job spawns per-handler jobs (`jobId = {event_id}:{handler}`), so retries re-run only the failed handler.
- After final failure the job lands in the failed set = **DLQ**. Alerting: failed-count metric → Sentry/alert channel with `event_name`, `handler`, `tenant_id`, error.
- Replay: an admin command re-enqueues DLQ jobs (idempotency ledger makes replay safe); a broader backfill can re-dispatch from `domain_events` by time range/event name.
- Poison-pill guard: payloads failing zod validation go straight to DLQ (no retries — they will never succeed).

---

## 7. End-to-end sequence

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as API (team module)
    participant UOW as UnitOfWork (packages/db)
    participant PG as PostgreSQL
    participant REL as Outbox Relay
    participant Q as BullMQ (Redis)
    participant W as Event Worker
    participant H1 as analytics handler
    participant H2 as notification handler

    C->>API: POST /api/v1/teams/:id/members (add member)
    API->>UOW: execute(ctx, work)
    UOW->>PG: BEGIN; SET LOCAL app.tenant_id
    UOW->>PG: INSERT team_memberships (ACTIVE)
    UOW->>PG: INSERT domain_events (MemberJoinedTeam)
    UOW->>PG: COMMIT  -- state + event atomic
    API-->>C: 201 Created
    PG--)REL: NOTIFY domain_events_new
    REL->>PG: SELECT ... WHERE dispatched_at IS NULL FOR UPDATE SKIP LOCKED
    REL->>Q: add job (jobId = event_id)
    REL->>PG: UPDATE dispatched_at = now()
    Q->>W: deliver job
    W->>W: cls.run(TenantContext from envelope)
    par fan-out per handler
      W->>H1: handle(event)
      H1->>PG: INSERT processed_events ON CONFLICT DO NOTHING + mark team dirty
    and
      W->>H2: handle(event)
      H2->>H2: send "welcome to team" notification (dedupe key event_id:template)
    end
    Note over W,H2: any handler failure → retry w/ backoff → DLQ after 5 attempts
```

---

## 8. Observability & testing

- Relay lag metric: `now() - min(created_at) WHERE dispatched_at IS NULL` — alert if > 30s.
- Queue depth, failure counts per event/handler exported as metrics; every handler log line carries `event_id`, `event_name`, `tenant_id`, `correlation_id` (pino).
- Tests: (a) outbox atomicity — force rollback after event append, assert no event row; (b) handler idempotency — deliver every handler the same event twice, assert single effect; (c) tenant context — handler for Tenant A cannot touch Tenant B rows (Prisma extension throws / RLS blocks); (d) DLQ replay is a no-op for already-processed handlers.
