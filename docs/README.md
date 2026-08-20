# AVIORA — Architecture Documentation

> **AVIORA** — The Operating System for Membership-Driven Healthy Living Communities.
> Multi-tenant Membership, Healthy Living & Growth OS. Generated 2026-08-19 from
> [`SPEC-master-prompt.md`](./SPEC-master-prompt.md) (the original master specification).

These documents are the **architectural source of truth** (spec §79). Implementation
begins only after the first vertical slice plan is approved (spec FINAL INSTRUCTION).

## Reading order

| #   | Document                                                               | Covers                                                    |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| 00  | [Architecture Assessment](./00-architecture-assessment.md)             | Strengths, risks, trade-offs, judgment calls              |
| 01  | [Product Vision](./01-product-vision.md)                               | Vision, 14 principles, tenant types, north star           |
| 02  | [Domain Map](./02-domain-map.md)                                       | 18 domains, dependencies, phase boundaries                |
| 03  | [Multi-Tenant Architecture](./03-multi-tenant-architecture.md)         | Tenant resolution, TenantContext, 10-layer isolation, RLS |
| 04  | [Membership Model](./04-membership-model.md)                           | Plans, membership lifecycle, entitlements                 |
| 05  | [Team Architecture](./05-team-architecture.md)                         | Closure table, leadership, move/merge, graph separation   |
| 06  | [Member Lifecycle](./06-member-lifecycle.md)                           | Configurable lifecycle / growth / onboarding journeys     |
| 07  | [Role & Permission Matrix](./07-role-permission-matrix.md)             | RBAC, scopes, ~70 permission keys, health privacy         |
| 08  | [Data Model](./08-data-model.md)                                       | 38 MVP tables, conventions, RLS policy pattern            |
| 09  | [ER Diagrams](./09-er-diagram.md)                                      | 5 focused Mermaid ER diagrams                             |
| 10  | [API Design](./10-api-design.md)                                       | REST /api/v1, 125 MVP endpoints, pagination, errors       |
| 11  | [Event Architecture](./11-event-architecture.md)                       | ~50 domain events, outbox, BullMQ, idempotency            |
| 12  | [AI Architecture](./12-ai-architecture.md)                             | AI Gateway, agents, permission-aware context, RAG plan    |
| 13  | [Security Architecture](./13-security-architecture.md)                 | AuthN/Z, isolation defense-in-depth, threat model         |
| 14  | [MVP Scope](./14-mvp-scope.md)                                         | In/out of scope, Definition of MVP Done                   |
| 15  | [MVP User Journeys](./15-mvp-user-journey.md)                          | Vertical slices 1–3 end-to-end                            |
| 16  | [Development Roadmap](./16-development-roadmap.md)                     | MVP → Phase 2/3/4, 20 dev rules                           |
| 17  | [Test Strategy](./17-test-strategy.md)                                 | Tenant-isolation suite (top priority), CI gates           |
| 18  | [Deployment Architecture](./18-deployment-architecture.md)             | Environments, CI/CD, custom domains, backups              |
| 19  | [Observability](./19-observability.md)                                 | Logs, tracing, metrics, alerts, dashboards                |
| 20  | [ADR Log](./20-adr.md)                                                 | 13 architecture decision records                          |
| 21  | [Repository Structure](./21-repository-structure.md)                   | Monorepo layout, module layering, tooling                 |
| 22  | [Development Backlog](./22-development-backlog.md)                     | 59 stories, 14 epics, P0–Future                           |
| 23  | [Sprint Plan](./23-sprint-plan.md)                                     | Sprint 0 + Sprint 1 (Vertical Slice 1)                    |
| 24  | [Commerce Contract](./24-commerce-contract.md)                         | Sprint 8 — commerce + subscription routes and rules       |
| 25  | [Growth Contract](./25-growth-contract.md)                             | Sprint 9 — referral graph + rank engine                   |
| 26  | [Compensation Contract](./26-compensation-contract.md)                 | Sprint 10 — compensation graph, rules, commission runs    |
| 27  | [Automation & Reward Contract](./27-automation-reward-contract.md)     | Sprint 11 — trigger/action rules, reward grants           |
| 28  | [Analytics & Coach Contract](./28-analytics-coach-contract.md)         | Sprint 12 — four dashboards, AI team coach                |
| 29  | [White Label & Country Contract](./29-white-label-country-contract.md) | Sprint 13 — branding, localisation, legal, tax            |
| 30  | [Public API & Webhooks Contract](./30-public-api-webhooks-contract.md) | Sprint 14 — webhooks, API keys, manifest                  |

## Canonical stack (see ADRs)

pnpm + Turborepo monorepo · Next.js 15 (App Router, Tailwind, PWA, next-intl th/en) ·
NestJS 11 modular monolith · PostgreSQL 17 + Prisma (uuid v7, timestamptz everywhere,
`tenant_id` + RLS via `app.tenant_id`) · Redis + BullMQ · Cloudflare R2 ·
provider-agnostic AI Gateway (Anthropic first).

## The one rule above all

> Membership is the center. Team is the organizational structure. Knowledge drives trust.
> Healthy Living drives value. AI drives intelligence. Commerce supports the journey.
> Compensation is optional and configurable. **Everything is tenant-aware.**
