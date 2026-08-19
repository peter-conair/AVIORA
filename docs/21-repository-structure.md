# 21 — Repository Structure

> **Project:** AVIORA · **Date:** 2026-08-19 · **Status:** Accepted
> FINAL INSTRUCTION item 11: recommended repository structure.
> Monorepo: **pnpm workspaces + Turborepo**. One repo, one deployable API (modular monolith), one web app, shared packages.

---

## 1. Top-level layout

```
aviora/
├── apps/
│   ├── web/                     # Next.js 15 (App Router) — member/leader/admin UI, PWA
│   └── api/                     # NestJS 11 — modular monolith
├── packages/
│   ├── db/                      # Prisma schema, client factory, tenant extension, unit of work
│   ├── shared/                  # Types, event schemas, permission keys, error codes, utils
│   └── config/                  # Shared tooling config (eslint, tsconfig, prettier, tailwind preset)
├── docs/                        # Architecture docs (this set) + ADRs
│   └── adr/
├── scripts/                     # Dev/ops scripts (setup, seed, git hooks install, db tasks)
├── .github/
│   └── workflows/               # ci.yml (lint+typecheck+test), gitleaks.yml, deploy.yml
├── .husky/                      # pre-commit / pre-push hooks
├── .gitleaks.toml
├── .env.example                 # placeholders only — never real values
├── turbo.json
├── pnpm-workspace.yaml
├── package.json                 # root: scripts + devDeps only (no runtime deps at root)
└── README.md
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

---

## 2. `apps/api` — NestJS modular monolith

Every domain module follows the same four-layer convention. **MVP modules (frozen list):** `identity`, `tenant`, `membership`, `team`, `goal`, `learning`, `crm`, `notification`, `analytics`, `ai`, `audit`, `platform`.

```
apps/api/
├── src/
│   ├── main.ts                          # bootstrap: pino, CLS, global pipes/filters
│   ├── app.module.ts                    # imports all domain modules + common
│   │
│   ├── common/                          # cross-cutting, NOT a domain module
│   │   ├── tenant/                      # TenantResolver, TenantContextMiddleware, RequireTenantGuard
│   │   ├── auth/                        # JwtAuthGuard, PermissionGuard, @Permissions() decorator
│   │   ├── cls/                         # nestjs-cls setup, TenantContext accessor
│   │   ├── events/                      # outbox relay, BullMQ worker, @EventsHandler discovery
│   │   ├── cache/                       # TenantCacheService (tenant:{id}: prefixing)
│   │   ├── storage/                     # R2 StorageService (/tenants/{id}/ prefixing, presign)
│   │   ├── http/                        # error envelope filter, cursor pagination helpers
│   │   ├── i18n/                        # server-side message catalogs (th/en) for emails etc.
│   │   └── observability/               # pino config, request-id, Sentry, OTel hooks
│   │
│   └── modules/
│       ├── identity/                    # ← the four-layer convention (shown expanded)
│       │   ├── identity.module.ts       # Nest module wiring; declares EXPORTED providers
│       │   ├── index.ts                 # PUBLIC API — the only file other modules may import
│       │   ├── domain/                  # pure TS: entities, value objects, domain errors,
│       │   │   │                        #   domain services; NO Nest/Prisma imports
│       │   │   ├── user.entity.ts
│       │   │   ├── tenant-membership.entity.ts
│       │   │   └── identity.errors.ts
│       │   ├── application/             # use cases; orchestrates domain + ports;
│       │   │   │                        #   receives TenantContext explicitly
│       │   │   ├── services/            #   exported application services live here
│       │   │   │   └── identity.service.ts
│       │   │   ├── handlers/            #   domain-event handlers (@EventsHandler)
│       │   │   ├── commands/            #   command/query DTO types (internal)
│       │   │   └── ports/               #   interfaces implemented by infrastructure
│       │   │       └── user.repository.port.ts
│       │   ├── infrastructure/          # Prisma repositories, external clients
│       │   │   ├── user.prisma-repository.ts
│       │   │   └── argon2.hasher.ts
│       │   └── api/                     # HTTP edge: controllers, request/response DTOs (zod),
│       │       │                        #   mappers; thin — no business logic
│       │       ├── auth.controller.ts
│       │       └── dto/
│       │
│       ├── tenant/          # same 4 layers: domain/ application/ infrastructure/ api/
│       ├── membership/      # plans, memberships, entitlements
│       ├── team/            # teams, closure, leadership, scope resolution (doc 05)
│       ├── goal/            # goals, dreams, habits (MVP: goals+dreams)
│       ├── learning/        # courses, lessons, progress
│       ├── crm/             # leads, customers, follow-ups, interactions
│       ├── notification/    # in-app + email; channel adapters
│       ├── analytics/       # metric snapshots, dashboards
│       ├── ai/              # gateway, adapters, router, context assembler (doc 12)
│       ├── audit/           # audit log write/read
│       └── platform/        # platform admin: tenant provisioning, platform plans, platform metrics
│
├── test/
│   ├── integration/                     # per-module integration tests (real Postgres via testcontainers)
│   │   ├── tenant-isolation.spec.ts     # THE test suite (doc 03 §7) — CI-blocking
│   │   └── team-hierarchy.spec.ts
│   └── e2e/                             # API-level E2E (supertest against booted app)
├── vitest.config.ts
└── project.json / package.json
```

### Layer rules (per module)

| Layer             | May import                                                                    | Must not import                           |
| ----------------- | ----------------------------------------------------------------------------- | ----------------------------------------- |
| `domain/`         | `packages/shared` only                                                        | Nest, Prisma, other modules               |
| `application/`    | own `domain/`, own `ports/`, `packages/shared`, **other modules' `index.ts`** | other modules' internals, Prisma directly |
| `infrastructure/` | own `domain/` + `application/ports`, `packages/db`                            | other modules entirely                    |
| `api/`            | own `application/`, `common/`                                                 | other modules, Prisma                     |

---

## 3. `apps/web` — Next.js 15 App Router

```
apps/web/
├── src/
│   ├── app/
│   │   ├── [locale]/                    # next-intl locale segment (th | en)
│   │   │   ├── (auth)/                  # sign-in, sign-up, invitation accept
│   │   │   ├── (member)/                # member-facing: dashboard, goals, learning, profile
│   │   │   ├── (leader)/                # team dashboards, org drill-down
│   │   │   ├── (tenant-admin)/          # tenant administration
│   │   │   ├── (platform)/              # platform admin (separate auth surface)
│   │   │   └── layout.tsx
│   │   ├── api/                         # route handlers only where unavoidable (BFF-light);
│   │   │                                #   business logic stays in apps/api
│   │   └── manifest.ts                  # PWA manifest
│   ├── components/
│   │   ├── ui/                          # design-system primitives
│   │   └── features/                    # feature components grouped by domain (team/, goal/, crm/ ...)
│   ├── lib/
│   │   ├── api-client/                  # typed client for /api/v1 (generated or hand-rolled from shared types)
│   │   ├── auth/                        # session helpers, tenant switcher state
│   │   └── i18n/                        # next-intl config
│   ├── messages/
│   │   ├── th.json                      # no hard-coded UI text — lint-enforced
│   │   └── en.json
│   └── styles/
├── e2e/                                 # Playwright specs (web-level user journeys)
│   └── first-vertical-slice.spec.ts     # spec §72 as an executable test
├── playwright.config.ts
├── next.config.ts                       # PWA (serwist), security headers
├── tailwind.config.ts                   # extends packages/config/tailwind-preset
└── package.json
```

---

## 4. Packages

```
packages/db/
├── prisma/
│   ├── schema.prisma                    # snake_case @map/@@map, uuid v7 defaults, Timestamptz(6)
│   ├── migrations/                      # includes raw SQL: RLS policies, partial unique indexes,
│   │                                    #   closure helpers, LISTEN/NOTIFY trigger
│   └── seed.ts                          # idempotent platform seed (dev fixtures behind env flag)
├── src/
│   ├── client.ts                        # createPrismaClient(getTenantId) → tenant extension applied
│   ├── platform-client.ts               # platformPrisma — ONLY importable by platform module (lint rule)
│   ├── tenant-extension.ts              # auto-inject tenant_id (doc 03 §4.2)
│   ├── unit-of-work.ts                  # TX wrapper: SET LOCAL app.tenant_id + outbox append (doc 11 §4)
│   └── index.ts
└── package.json

packages/shared/
├── src/
│   ├── tenant-context.ts                # TenantContext interface
│   ├── events/                          # DomainEvent envelope + zod payload schemas per event_name
│   ├── permissions/                     # permission key constants (dot-notation) + scope enum
│   │   └── keys.ts                      #   SELF | DIRECT_TEAM | DESCENDANT_TEAMS | SPECIFIC_TEAMS | TENANT_ALL
│   ├── errors/                          # error codes for the API envelope
│   ├── api/                             # request/response types shared with apps/web
│   └── utils/                           # uuid v7, cursor codec, date/tz helpers
└── package.json

packages/config/
├── eslint/                              # base + nest + next configs, incl. boundary rules (§5)
├── tsconfig/                            # tsconfig.base.json, per-target extends
├── prettier/
└── tailwind-preset/
```

---

## 5. Module boundary rules (enforced, not aspirational)

1. **Modules communicate only via (a) domain events or (b) application services exported from the other module's `index.ts`.** Never import from `modules/x/domain|application|infrastructure/**` across module lines.
2. **A module owns its tables.** Cross-module data reads go through the owning module's exported service — no reaching into another module's Prisma models. (Read-model exceptions require an ADR.)
3. **Graph separation** (doc 05 §6): `team` never imports referral/compensation services for placement logic and vice versa.
4. **`packages/db` is imported only by `infrastructure/` layers and `common/`**; `platform-client.ts` only by the `platform` module.
5. **No provider SDKs outside `modules/ai/infrastructure/`** (Anthropic etc.).

Enforced with `eslint-plugin-boundaries` (or `import/no-restricted-paths`) in `packages/config/eslint`:

```js
// sketch: packages/config/eslint/boundaries.cjs
rules: {
  'boundaries/element-types': ['error', {
    default: 'disallow',
    rules: [
      { from: 'module-api',            allow: ['module-application', 'common', 'shared'] },
      { from: 'module-application',    allow: ['module-domain', 'module-ports', 'shared', 'other-module-public'] },
      { from: 'module-infrastructure', allow: ['module-domain', 'module-ports', 'db', 'shared'] },
      { from: 'module-domain',         allow: ['shared'] },
    ],
  }],
}
```

CI fails on violations; there is no override comment allowed without an ADR reference.

---

## 6. Naming conventions

| Thing                  | Convention                                                           | Example                                           |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| DB tables / columns    | snake_case plural tables, snake_case columns (Prisma `@@map`/`@map`) | `team_memberships.joined_at`                      |
| Prisma models / fields | PascalCase / camelCase                                               | `TeamMembership.joinedAt`                         |
| Primary keys           | uuid v7                                                              | `018f4c2e-...`                                    |
| Timestamps             | `timestamptz` always (`@db.Timestamptz(6)`); `*_at` suffix           | `created_at`, `effective_from`                    |
| Domain events          | PascalCase, past tense                                               | `MemberJoinedTeam`                                |
| Permission keys        | dot-notation, lowercase                                              | `team.member.view`, `health.profile.view`         |
| Entitlement keys       | dot-notation, lowercase                                              | `ai.coach`, `team.create`                         |
| REST routes            | `/api/v1`, kebab-case, plural resources                              | `GET /api/v1/teams/{id}/descendants`              |
| Files                  | kebab-case with role suffix                                          | `team-closure.service.ts`, `move-team.handler.ts` |
| NestJS classes         | PascalCase with role suffix                                          | `TeamClosureService`, `MoveTeamHandler`           |
| React components       | PascalCase files in feature dirs                                     | `TeamDashboardCard.tsx`                           |
| Env vars               | SCREAMING_SNAKE, prefixed                                            | `AVIORA_DATABASE_URL`, `AVIORA_AI_ANTHROPIC_KEY`  |
| Branches / commits     | `feat/team-move`, Conventional Commits                               | `feat(team): subtree move with closure rewrite`   |
| i18n keys              | dot-notation by feature                                              | `team.dashboard.directMembers`                    |

---

## 7. Where tests live

| Test type                                                      | Location                                             | Runner                   |
| -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------ |
| Unit (domain/application)                                      | co-located `*.spec.ts` next to source                | vitest                   |
| Module integration (real Postgres, RLS on, via testcontainers) | `apps/api/test/integration/`                         | vitest                   |
| **Tenant isolation suite** (CI-blocking, doc 03 §7)            | `apps/api/test/integration/tenant-isolation.spec.ts` | vitest                   |
| API E2E (booted app, supertest)                                | `apps/api/test/e2e/`                                 | vitest                   |
| Web unit/component                                             | co-located in `apps/web/src`                         | vitest + testing-library |
| Web E2E (user journeys, incl. spec §72 slice)                  | `apps/web/e2e/`                                      | playwright               |
| Shared package units                                           | co-located in each package                           | vitest                   |

Rule: integration tests run against a **RLS-enabled** database as the non-privileged `aviora_app` role — testing with the table owner would silently disable the backstop.

---

## 8. Tooling configuration

| Tool                     | Config                                              | Purpose                                                                                    |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **eslint** (flat config) | `packages/config/eslint`, extended per app          | boundaries (§5), no-literal-JSX-text (i18n), import hygiene                                |
| **prettier**             | `packages/config/prettier`                          | formatting; no debates                                                                     |
| **typescript**           | `packages/config/tsconfig` (`strict: true`)         | shared strict base                                                                         |
| **vitest**               | per-package `vitest.config.ts`                      | unit + integration                                                                         |
| **playwright**           | `apps/web/playwright.config.ts`                     | web E2E                                                                                    |
| **gitleaks**             | `.gitleaks.toml` + `.github/workflows/gitleaks.yml` | secret scanning: pre-commit (L1) + CI on every push/PR (L2)                                |
| **husky**                | `.husky/pre-commit`, `.husky/pre-push`              | pre-commit: gitleaks → lint-staged (eslint+prettier) → typecheck; pre-push: affected tests |
| **lint-staged**          | root `package.json`                                 | fast staged-file checks                                                                    |
| **turbo**                | `turbo.json`                                        | task graph: `build`, `lint`, `typecheck`, `test`, `e2e` with caching                       |
| **prisma**               | `packages/db`                                       | schema, migrations (incl. raw RLS SQL)                                                     |
| **commitlint**           | root                                                | Conventional Commits                                                                       |

`turbo.json` sketch:

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] },
    "e2e": { "dependsOn": ["build"], "cache": false }
  }
}
```

Root scripts: `pnpm dev` (turbo run dev --parallel), `pnpm check` (lint + typecheck + test — the pre-push gate), `pnpm db:migrate`, `pnpm db:seed`.

---

## 9. Day-1 hygiene (non-negotiable)

- `.env.example` committed with placeholders; all real secrets in `.env.local`-style files that are gitignored (`.env*` ignored, `!.env.example` negated).
- gitleaks installed in pre-commit **before** the first secret exists; CI gitleaks job required on `main`.
- `main` is protected: CI (lint, typecheck, test, tenant-isolation suite, gitleaks) must pass to merge.
- Every architectural decision that deviates from these docs gets an ADR in `docs/adr/` (`NNNN-title.md`), following spec §78.20.
