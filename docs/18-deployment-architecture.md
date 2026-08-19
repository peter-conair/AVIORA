# 18 — Deployment Architecture

> **AVIORA** — environments, production topology, CI/CD, tenant domains, backup, rollback, and cost guardrails.
>
> Status: Approved · Last updated: 2026-08-19 · Source of truth: MASTER AI CODING PROMPT (spec §61–§63, §68); global production-safety and security rules

---

## 1. Environments

| Environment    | Purpose                                                     | Infra                                | Data                                                   |
| -------------- | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| **local**      | Development                                                 | docker-compose on dev machine        | Seeded fixtures only                                   |
| **staging**    | Pre-production verification, E2E smoke, migration rehearsal | Same topology as prod, smaller sizes | Synthetic + anonymized fixtures — never production PII |
| **production** | Live tenants                                                | Managed infra behind Cloudflare      | Real, backed up, PITR                                  |

### 1.1 Local (docker-compose)

```yaml
# docker-compose.yml (shape — canonical file lives at repo root)
services:
  postgres:
    image: postgres:17-alpine # ALWAYS 17-alpine — never latest/18+
    environment: [POSTGRES_DB=aviora, POSTGRES_USER=aviora, POSTGRES_PASSWORD=...]
    volumes: [pgdata:/var/lib/postgresql/data]
    ports: ['5432:5432']
  redis:
    image: redis:7-alpine
    command: ['redis-server', '--requirepass', '${REDIS_PASSWORD}']
  api:
    build: apps/api # NestJS 11 — also runs BullMQ workers locally
    environment: [TZ=UTC, DATABASE_URL=..., REDIS_URL=...]
    depends_on: [postgres, redis]
    ports: ['3001:3001']
  web:
    build: apps/web # Next.js 15
    ports: ['3000:3000']
volumes:
  pgdata: # NEVER remove this volume (db-protection rules)
```

Rules:

- `TZ=UTC` for every service; all columns `timestamptz`; convert to tenant timezone at the edge.
- The Postgres volume is protected: no `compose down -v`, no `--force-recreate`/`--build` targeting the db service, no volume prune (see global db-protection rules).
- App containers rebuild with `docker compose up -d --build api web` — never a bare `--build` that touches the db.
- Two Postgres roles from day 1: a migration/owner role and a **non-owner app role** (RLS applies only to non-owners).

### 1.2 Staging

- Mirrors production topology (Cloudflare, managed Postgres, Redis, R2 staging bucket) at minimum sizes.
- Every deploy to production must first pass staging: migrations rehearsed here, Playwright smoke runs post-deploy.
- Access restricted (Cloudflare Access); robots disallowed.

## 2. Production Topology

```text
                        Internet
                           │
                   ┌───────▼────────┐
                   │   Cloudflare   │  DNS · TLS · WAF · rate limiting · CDN
                   │  (+ CF for SaaS│  tenant custom domains)
                   └───────┬────────┘
              ┌────────────┼─────────────┐
              ▼                          ▼
      ┌──────────────┐          ┌──────────────┐
      │  web (Next.js│          │  api (NestJS │  /api/v1 · TenantContext
      │  15 container│          │  11 container│  · RLS via app.tenant_id
      └──────┬───────┘          └──────┬───────┘
             │                         │
             │        ┌────────────────┼──────────────────┐
             │        ▼                ▼                  ▼
             │  ┌──────────┐    ┌───────────┐      ┌────────────┐
             │  │ Managed  │    │   Redis   │      │ Cloudflare │
             │  │ Postgres │    │ (cache +  │      │     R2     │
             │  │ 17 + RLS │    │  BullMQ)  │      │  /tenants/ │
             │  │ + PITR   │    └─────┬─────┘      │ {tenant_id}│
             │  └──────────┘          │            └────────────┘
             │                 ┌──────▼───────┐
             │                 │ worker       │  BullMQ consumer:
             │                 │ (api image,  │  outbox relay, notifications,
             │                 │ worker mode) │  automations, AI jobs
             │                 └──────────────┘
```

Components:

- **Cloudflare** fronts everything: DNS, TLS termination, WAF, bot management, per-route rate limits (auth + AI endpoints tightest), CDN for static assets.
- **web** — Next.js 15 container (PWA, next-intl th/en). Server-side calls go to the api service internally.
- **api** — NestJS 11 container. Every request resolves TenantContext → sets `app.tenant_id` on the DB session → RLS enforces isolation beneath the ORM.
- **worker** — same image as api started in worker mode (`node dist/worker.js`). Consumes BullMQ queues: transactional-outbox relay (`domain_events` → queues), notifications (email/LINE/push), automation triggers, AI background jobs, scheduled jobs (membership expiry, digests). Scales independently of the api.
- **Managed PostgreSQL 17** — provider-managed (with automated backups + PITR). RLS policies on every tenant-owned table.
- **Redis** — cache (tenant-prefixed keys) + BullMQ backing store. Password-protected, private network only.
- **Cloudflare R2** — object storage; keys always `/tenants/{tenant_id}/...`, member-private files under `/tenants/{tenant_id}/members/{member_id}/...`. Access via short-lived signed URLs minted by the api after permission checks — the bucket is never public.

Observability (spec §68): structured JSON logs carrying `request_id`, `tenant_id`, `user_id`; error tracking (Sentry or equivalent); queue depth and job-failure metrics; AI usage/cost per tenant; uptime checks on `/healthz` (liveness) and `/readyz` (DB + Redis connectivity).

## 3. CI/CD (GitHub Actions)

```text
push / PR
   │
   ├── verify:  lint → typecheck → gitleaks → unit → integration → isolation suite → e2e
   │            (all required checks — see 17-test-strategy.md §14)
   │
   ├── build:   docker build api, web (multi-stage, pinned base images)
   │            → push to registry tagged {git-sha}
   │
   └── deploy (main only, after verify + build green):
         1. deploy staging → prisma migrate deploy runs on api boot
         2. staging smoke (Playwright critical path + /readyz)
         3. deploy production (same sha)
         4. post-deploy job:
              a. run idempotent seed script   (reference data, roles, permissions,
                                               entitlement catalog — safe to re-run)
              b. flush permission/config cache (redis-cli with REDIS_PASSWORD —
                                               scoped FLUSH of cache namespace)
         5. production smoke + error-rate watch
```

Rules:

- **main = production.** No direct pushes to main; PRs only; all checks required. Never merge with red CI.
- **Migrations auto-run on boot** via `prisma migrate deploy` in the api entrypoint (before the HTTP server binds; worker waits for readiness). Migrations must be backward-compatible with the previous app version (expand → migrate → contract pattern) so rollback stays possible.
- **Seed script is idempotent** — the single source of truth for reference data; running it twice yields identical state. Post-deploy always runs seed + cache flush so new permissions/menus/config appear immediately (stale cached permissions are a known failure mode).
- Secrets live in GitHub Actions secrets / the platform's secret store — never in compose files, workflow yaml, or the repo. gitleaks runs pre-commit (L1) and in CI (L2).
- No Friday-evening deploys without someone watching; deploy when able to monitor.

## 4. Tenant Custom Domains (Cloudflare for SaaS)

Resolution order (spec §6): `{tenant-slug}.aviora.app` subdomain → custom domain → authenticated context → `X-Tenant-ID` (internal only, never trusted beyond the caller's TenantMembership).

Custom-domain flow:

1. Tenant admin enters `members.tenantdomain.com` in tenant settings.
2. API creates a **Custom Hostname** via the Cloudflare for SaaS API; tenant is shown the CNAME target (`customers.aviora.app`) and, when required, a TXT ownership-verification record.
3. Cloudflare validates ownership and issues/renews the TLS certificate automatically.
4. A background job polls hostname status → marks the domain `active` on the Tenant record → requests with that `Host` header resolve TenantContext by custom domain.
5. Removal deletes the custom hostname and reverts the tenant to its subdomain.

Fallback-origin is the web app; the api recognizes both subdomain and custom-domain hosts. Certificate issuance/renewal is fully Cloudflare-managed — no cert material ever stored by us.

## 5. Backup & PITR

| Asset          | Mechanism                                              | Target                           |
| -------------- | ------------------------------------------------------ | -------------------------------- |
| PostgreSQL     | Provider automated daily snapshots **+ PITR (WAL)**    | RPO ≤ 5 min, retention ≥ 14 days |
| R2 objects     | Bucket versioning + scheduled cross-bucket replication | RPO ≤ 24 h                       |
| Redis          | Treated as disposable (cache + queues); AOF optional   | Rebuildable from Postgres        |
| Config/secrets | Secret store is source of truth; infra-as-code in repo | —                                |

Rules:

- **Restore is tested quarterly** on staging — a backup that has never been restored is not a backup.
- Before any destructive migration or bulk data change: explicit snapshot first, rehearse on a staging copy, migration written idempotent. Never run destructive DDL/DML without a backup path (production-safety rules).
- Tenant offboarding exports (`/tenants/{tenant_id}` data + objects) before any deletion, with a retention window.

## 6. Rollback Strategy

| Failure                           | Response                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad deploy, no migration involved | Redeploy previous image tag (`{git-sha}`) — minutes, zero data risk                                                                                                        |
| Bad deploy, migration ran         | Roll back **app only** — migrations are expand/contract, so previous app version runs against the new schema. Never `migrate down` in production.                          |
| Data-corrupting bug               | Stop the writer (scale worker/api down as needed) → assess blast radius → PITR restore to a side database → surgically repair, or full restore if unavoidable → postmortem |
| Bad seed/config                   | Seed is idempotent — fix data, re-run seed, flush cache                                                                                                                    |

Standing rules: roll forward is preferred when a fix is fast and verified; every rollback path is decided _before_ deploy (the checklist item "what's the undo?" is part of PR review for risky changes); deployment history retains at least the last 10 image tags.

## 7. Cost Guardrails

Per global production-safety rules (§3) and spec §53 (platform must track AI cost, storage, usage):

- **Billing budget alerts** on every provider account (Cloudflare, DB host, LLM providers) at ≥2× expected monthly spend, plus a 50%-of-budget early warning.
- **AI daily quota caps per tenant** — enforced in the AI Gateway: per-tenant daily token/request budget (plan-entitlement-driven, e.g. `ai.quota.daily`), per-member sub-limits, and a global platform kill-switch. Exceeding quota returns a friendly 429; usage is recorded in `ai_usage` with tenant attribution and surfaced on the platform dashboard.
- Every provider API key is restricted (IP/API restrictions) _before first use_; app-level quotas do not protect a leaked key — key restrictions do (secret-protection rules).
- Rate limits at Cloudflare and per-route in the api on expensive endpoints (auth, AI, email/LINE sends, exports).
- Notification sends (email/LINE) have per-tenant daily caps with alerting on anomalies.
- R2 storage per tenant is metered (usage rollup job) → feeds plan limits and platform dashboard.
- Weekly ops review: billing dashboards, AI cost per tenant, error rates, queue depth.
