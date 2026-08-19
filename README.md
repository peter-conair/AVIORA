# AVIORA

> The Operating System for Membership-Driven Healthy Living Communities.
> Multi-tenant Membership, Healthy Living & Growth OS.

**Architecture source of truth:** [`docs/`](./docs/README.md) (24 documents — vision, domain map, data model, security, API, ADRs, backlog, sprint plan).

## Stack

pnpm + Turborepo monorepo · Next.js 15 (`apps/web`, th/en, PWA) · NestJS 11 (`apps/api`, modular monolith) · PostgreSQL 17 + Prisma (`packages/db`, uuid v7, timestamptz, **Row-Level Security per tenant**) · Redis · Cloudflare R2.

## Getting started

```bash
cp .env.example .env       # fill in local values
pnpm install
docker compose up -d       # postgres :5439 · redis :6379 · mailpit :8025
pnpm --filter @aviora/db db:migrate
pnpm --filter @aviora/db db:setup-app-role
pnpm --filter @aviora/db db:seed
pnpm dev                   # web :3020 · api :3021
```

## Key commands

| Command                                      | What                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                                 | lint + typecheck + unit tests (pre-push gate)                                                                                              |
| `pnpm --filter @aviora/api test:integration` | **tenant-isolation suite** (RLS, CI-blocking) — stop the dev API first: its outbox relay is cross-tenant and would drain the tests' events |
| `pnpm db:migrate` / `pnpm db:seed`           | migrations / idempotent seed                                                                                                               |

## Non-negotiables

1. Every tenant-owned table has `tenant_id` + RLS (`app.tenant_id` via `withTenant()`).
2. The API runs as the non-owner `aviora_app` role — never the table owner.
3. No plan-name/role-name branching — permissions + entitlements only.
4. Team graph ≠ referral graph ≠ compensation graph.
5. All timestamps `timestamptz`. No secrets in the repo — gitleaks enforces.

See [`docs/README.md`](./docs/README.md) for everything else.
