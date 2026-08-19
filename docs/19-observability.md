# 19 — Observability

> **Project:** AVIORA — Multi-Tenant Membership, Healthy Living & Growth Operating System
> **Status:** Approved for MVP · **Last updated:** 2026-08-19
> **Spec references:** §68 (observability), §60 (audit), §53 (analytics dashboards)
> **Stack:** NestJS 11 · pino · OpenTelemetry · Sentry · Prometheus-style metrics · BullMQ

---

## 1. Goals

Per spec §68, AVIORA implements: structured logging, error tracking, request tracing,
metrics, audit events, queue monitoring, AI usage monitoring, AI cost monitoring, and
tenant usage monitoring. Every signal is correlatable through one id:

```text
request_id  →  log lines  →  trace spans  →  Sentry events  →  audit records
```

---

## 2. Structured Logging (pino)

JSON logs to stdout via **pino** (`nestjs-pino`), shipped by the platform log collector.
Human-pretty output only in local dev.

### 2.1 Mandatory fields on every request-scoped line

Injected automatically from `TenantContext` (nestjs-cls) — services never add them by hand:

| Field        | Source                                                                             | Notes                            |
| ------------ | ---------------------------------------------------------------------------------- | -------------------------------- |
| `request_id` | Generated at edge / middleware (uuid v7); echoed as `X-Request-ID` response header | Always present                   |
| `tenant_id`  | Resolved tenant context                                                            | `null` on platform/public routes |
| `user_id`    | Verified JWT `sub`                                                                 | `null` pre-auth                  |
| `member_id`  | Tenant membership lookup                                                           | where applicable (spec §68)      |
| `ts`         | pino timestamp                                                                     | ISO-8601 UTC                     |
| `level`      | see §2.2                                                                           |                                  |
| `module`     | domain module name (`team`, `crm`, `ai`, …)                                        |                                  |
| `msg`        | short event description                                                            |                                  |

HTTP completion lines add: `method`, `path` (route template, **not** raw URL),
`status`, `duration_ms`. Queue jobs log the same set with `job_id`, `queue`,
`attempt` — and carry the originating `request_id` through the outbox event payload.

### 2.2 Log levels

| Level   | Use                                        | Examples                                                                       |
| ------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `fatal` | Process cannot continue                    | Failed boot, unrecoverable config error                                        |
| `error` | Request/job failed unexpectedly            | Unhandled exception, DB unavailable, webhook signature invalid                 |
| `warn`  | Suspicious but handled                     | Rate limit hit, retryable failure, idempotency replay, permission denial burst |
| `info`  | Normal significant events                  | Request completed, job completed, tenant created, deploy marker                |
| `debug` | Diagnostic detail (off in prod by default) | Guard decisions, cache hit/miss                                                |
| `trace` | Local dev only                             | SQL timings, payload shapes                                                    |

Prod default: `info`. Per-module override via env (`LOG_LEVEL_ai=debug`) for targeted
debugging without global noise.

### 2.3 What must NEVER be logged

Enforced with pino `redact` paths plus a serializer allow-list (log objects are built from
explicit fields, not spread from request objects):

- **Secrets & credentials:** passwords, JWTs, refresh tokens, cookies, `Authorization` headers, API keys, webhook signatures/secrets, encryption keys.
- **PII values:** email (log a user id instead), phone, address, national id, birthdate — identifiers only, never values.
- **Health data:** absolutely never — not even at `debug`/`trace`.
- **Full request/response bodies:** log route + status + duration + explicit whitelisted fields; never dump bodies. Validation errors log field _names_ and issue codes, not submitted values.
- **Raw SQL with bound values**, stack-trace local variables, base64 blobs, file contents.

Redact config baseline:

```ts
redact: {
  paths: [
    'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]',
    '*.password', '*.token', '*.refresh_token', '*.secret', '*.otp',
    '*.email', '*.phone', '*.address', '*.national_id',
  ],
  censor: '[REDACTED]',
}
```

---

## 3. Request Tracing (OpenTelemetry-ready)

- MVP wires the **OpenTelemetry SDK** (`@opentelemetry/sdk-node`) with auto-instrumentation for HTTP, Prisma/pg, ioredis, and BullMQ — exporting via OTLP; the backend (Tempo/Jaeger/vendor) is an ops choice, not a code change.
- W3C Trace Context (`traceparent`) is accepted at the edge and propagated to outbox events and queue jobs so async work joins the originating trace.
- `request_id` is attached as a span attribute (`aviora.request_id`) alongside `aviora.tenant_id` and `aviora.user_id`, and `trace_id` is added to every log line — logs ↔ traces are linkable in both directions.
- Sampling: 100% of errors, 10% head-sampling of successful requests (tunable per env); AI-gateway spans always sampled (cost analysis).
- Span naming: `HTTP GET /api/v1/teams/:id/dashboard` (route template), `queue:notifications.send`, `ai:gateway.complete`.

---

## 4. Error Tracking (Sentry)

- `@sentry/node` (backend) + `@sentry/nextjs` (frontend), initialized before Nest bootstrap; release tagged with the git SHA, environment tagged `dev|staging|prod`.
- Every event carries tags: `request_id`, `tenant_id`, `module`; user context is **id only** (no email/name — `sendDefaultPii: false`).
- `beforeSend` scrubber mirrors the pino redact list (belt and braces on top of Sentry's default scrubbing).
- Source maps uploaded in CI for both apps; frontend replay sampling only on errors, with privacy masking on all inputs.
- Alert rules: new issue in prod → engineering channel; regression of resolved issue → same; issue volume spike (>10×) → page.
- 4xx business errors (validation, permission denied) are **not** sent to Sentry — they are logs/metrics, not defects. 5xx and unhandled rejections always are.

---

## 5. Metrics

Prometheus-format `/metrics` endpoint (internal network only) via `prom-client`.
Label discipline: `tenant_id` appears only on the explicitly per-tenant series below
(bounded cardinality); never on high-cardinality series combined with route.

### 5.1 HTTP

- `http_requests_total{method,route,status}` — counter
- `http_request_duration_seconds{method,route}` — histogram (p50/p95/p99)
- `http_errors_total{route,code}` — counter (5xx and named 4xx codes)
- `rate_limited_total{tier}` — counter

### 5.2 Queue (BullMQ) & outbox

- `queue_depth{queue}` — gauge (waiting + delayed)
- `queue_job_duration_seconds{queue}` — histogram
- `queue_jobs_total{queue,status}` — counter (`completed|failed|retried`)
- `outbox_unpublished_events` — gauge (domain_events rows not yet dispatched)
- `outbox_publish_lag_seconds` — gauge (oldest unpublished event age)

### 5.3 Database & cache

- `db_pool_active_connections` / `db_pool_idle_connections` / `db_pool_waiting_requests` — gauges
- `db_query_duration_seconds{model,operation}` — histogram (Prisma middleware)
- `redis_operations_total{op,status}` · `cache_hit_ratio{cache}` — counter/gauge

### 5.4 Per-tenant usage (spec §68 tenant usage monitoring)

- `tenant_api_requests_total{tenant_id}` — counter
- `tenant_active_users{tenant_id}` — gauge (5-min window)
- `tenant_storage_bytes{tenant_id}` — gauge (R2, refreshed hourly)

### 5.5 AI usage & cost (spec §68 AI monitoring)

Emitted by the AI Gateway per call and persisted to `ai_usage` for billing-grade accuracy
(metrics are operational, the table is the source of truth):

- `ai_requests_total{tenant_id,agent,provider,model,status}` — counter
- `ai_tokens_total{tenant_id,model,direction}` — counter (`direction=input|output`)
- `ai_cost_usd_total{tenant_id,model}` — counter
- `ai_request_duration_seconds{provider,model}` — histogram
- `ai_budget_remaining_ratio{tenant_id}` — gauge (vs. tenant daily budget)

### 5.6 Business/security signals

- `auth_logins_total{status}` · `auth_lockouts_total` — counters
- `permission_denied_total{module}` — counter (escalation-probe detection)
- `webhook_signature_failures_total{source}` — counter
- `tenant_isolation_canary_failures_total` — counter — **any non-zero value pages immediately**

---

## 6. Health Checks

| Endpoint       | Purpose   | Behavior                                                                                                                                                                              |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz` | Liveness  | Process up + event loop responsive. No dependency checks (a dead DB must not cause restart loops). Always fast (<10 ms)                                                               |
| `GET /readyz`  | Readiness | Checks: Postgres `SELECT 1` (with timeout 1 s), Redis `PING`, BullMQ connection, pending-migrations = 0. Any failure → `503` with per-check detail; load balancer drains the instance |

Both are unauthenticated, excluded from rate limiting, logging sampled at 1%, and never
include version/config details beyond a build SHA.

---

## 7. Audit Events vs Logs — the Distinction

|              | **Logs**                           | **Audit events**                                                                            |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Purpose      | Operate & debug the system         | Answer "who did what to whom, when" — compliance & forensics                                |
| Audience     | Engineers                          | Tenant admins, compliance, support                                                          |
| Storage      | Log pipeline, 30-day retention     | `audit_log` table, append-only, 2 y hot + R2 archive                                        |
| Mutability   | Best-effort, sampled, reformatable | Immutable, written in the mutation's transaction, never sampled                             |
| Content      | Technical context, redacted        | Business fields incl. `before`/`after` snapshots (sensitive values redacted per doc 13 §10) |
| Access       | Ops tooling                        | `GET /audit-logs` behind `audit.view` permission                                            |
| Failure mode | Losing a log line is acceptable    | Losing an audit record is an incident — mutation rolls back with it                         |

A sensitive action therefore produces **both**: an `info` log line (with `request_id`) and
an audit row (with the same `request_id`) — but they are separate systems and one never
substitutes for the other.

---

## 8. Alerting Thresholds

Paging (24/7) vs. notify (working hours) split. All thresholds are starting points, tuned
after 30 days of baseline.

| Signal                                       | Threshold                                   | Severity                  |
| -------------------------------------------- | ------------------------------------------- | ------------------------- |
| `tenant_isolation_canary_failures_total` > 0 | any                                         | **Page immediately**      |
| HTTP 5xx rate                                | > 1% of requests over 5 min                 | Page                      |
| p95 latency (API overall)                    | > 800 ms over 10 min                        | Page                      |
| p95 latency (single route)                   | > 2 s over 10 min                           | Notify                    |
| `/readyz` failing                            | > 2 min on any instance                     | Page                      |
| DB pool waiting requests                     | > 5 sustained 5 min                         | Page                      |
| `outbox_publish_lag_seconds`                 | > 120 s                                     | Page                      |
| `queue_depth` (notifications)                | > 1,000 for 10 min                          | Notify                    |
| Queue failure ratio                          | > 5% over 15 min                            | Notify                    |
| Auth failures                                | > 100/min global or > 20/min single account | Notify (+ auto lockout)   |
| `webhook_signature_failures_total`           | > 10/h from one source                      | Notify                    |
| AI cost per tenant                           | > 80% of daily budget                       | Notify tenant admin + ops |
| AI cost platform-wide                        | > 120% of 7-day average                     | Page                      |
| Sentry new prod issue                        | any                                         | Notify                    |
| Error-budget burn (99.9% availability SLO)   | fast-burn 14×/1 h or slow-burn 6×/6 h       | Page / Notify             |
| Disk/storage growth                          | > 85% capacity                              | Notify                    |

---

## 9. Dashboards

| Dashboard                          | Audience       | Key panels                                                                                                                           |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **API Overview**                   | Eng/on-call    | Request rate, error rate, p50/p95/p99 by route, rate-limit hits, top slow routes                                                     |
| **Tenant Usage**                   | Eng + Product  | Requests, active users, storage, AI spend per tenant; top-10 tenants; anomaly deltas                                                 |
| **AI Gateway**                     | Eng + Finance  | Tokens & cost by tenant/model/agent, latency by provider, budget consumption, failure rate                                           |
| **Queues & Events**                | Eng/on-call    | Queue depths, job durations, failure/retry rates, outbox lag, DLQ size                                                               |
| **Database**                       | Eng/on-call    | Pool state, slow queries, per-model latency, RLS policy errors, replication/backup status                                            |
| **Security Signals**               | Eng + Security | Login failures/lockouts, permission-denied by module, webhook signature failures, session-reuse detections, isolation canary         |
| **Business Pulse** (from spec §53) | Product        | New tenants, member registrations, activations, learning completions, CRM conversions — sourced from domain events, not request logs |
| **Release Health**                 | Eng            | Error rate vs release SHA, Sentry new-issue count, deploy markers overlaid on latency                                                |

---

## 10. Implementation Notes

- One logging module (`@aviora/observability` package in the monorepo) exports the pino instance, OTel setup, metric registries, and the redact list — apps and workers import it; nothing configures logging locally.
- Log/trace context propagation uses the same nestjs-cls store as `TenantContext` — a single source of request-scoped truth.
- Local dev: `pino-pretty`, tracing to console exporter, Sentry disabled (`SENTRY_DSN` empty ⇒ no-op).
- CI check: a lint rule bans `console.log` in `apps/` and `packages/` (except scripts), keeping all output structured.

Related docs: [10-api-design.md](./10-api-design.md) §6 (error envelope with `request_id`) · [13-security-architecture.md](./13-security-architecture.md) §10 (audit fields)
