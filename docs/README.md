# AVIORA — Architecture Documentation

> **AVIORA** — The Operating System for Membership-Driven Healthy Living Communities.
> Multi-tenant Membership, Healthy Living & Growth OS. Generated 2026-08-19 from
> [`SPEC-master-prompt.md`](./SPEC-master-prompt.md) (the original master specification).

These documents are the **architectural source of truth** (spec §79). Implementation
begins only after the first vertical slice plan is approved (spec FINAL INSTRUCTION).

## Reading order

| #   | Document                                                                                          | Covers                                                    |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 00  | [Architecture Assessment](./00-architecture-assessment.md)                                        | Strengths, risks, trade-offs, judgment calls              |
| 01  | [Product Vision](./01-product-vision.md)                                                          | Vision, 14 principles, tenant types, north star           |
| 02  | [Domain Map](./02-domain-map.md)                                                                  | 18 domains, dependencies, phase boundaries                |
| 03  | [Multi-Tenant Architecture](./03-multi-tenant-architecture.md)                                    | Tenant resolution, TenantContext, 10-layer isolation, RLS |
| 04  | [Membership Model](./04-membership-model.md)                                                      | Plans, membership lifecycle, entitlements                 |
| 05  | [Team Architecture](./05-team-architecture.md)                                                    | Closure table, leadership, move/merge, graph separation   |
| 06  | [Member Lifecycle](./06-member-lifecycle.md)                                                      | Configurable lifecycle / growth / onboarding journeys     |
| 07  | [Role & Permission Matrix](./07-role-permission-matrix.md)                                        | RBAC, scopes, ~70 permission keys, health privacy         |
| 08  | [Data Model](./08-data-model.md)                                                                  | 38 MVP tables, conventions, RLS policy pattern            |
| 09  | [ER Diagrams](./09-er-diagram.md)                                                                 | 5 focused Mermaid ER diagrams                             |
| 10  | [API Design](./10-api-design.md)                                                                  | REST /api/v1, 125 MVP endpoints, pagination, errors       |
| 11  | [Event Architecture](./11-event-architecture.md)                                                  | ~50 domain events, outbox, BullMQ, idempotency            |
| 12  | [AI Architecture](./12-ai-architecture.md)                                                        | AI Gateway, agents, permission-aware context, RAG plan    |
| 13  | [Security Architecture](./13-security-architecture.md)                                            | AuthN/Z, isolation defense-in-depth, threat model         |
| 14  | [MVP Scope](./14-mvp-scope.md)                                                                    | In/out of scope, Definition of MVP Done                   |
| 15  | [MVP User Journeys](./15-mvp-user-journey.md)                                                     | Vertical slices 1–3 end-to-end                            |
| 16  | [Development Roadmap](./16-development-roadmap.md)                                                | MVP → Phase 2/3/4, 20 dev rules                           |
| 17  | [Test Strategy](./17-test-strategy.md)                                                            | Tenant-isolation suite (top priority), CI gates           |
| 18  | [Deployment Architecture](./18-deployment-architecture.md)                                        | Environments, CI/CD, custom domains, backups              |
| 19  | [Observability](./19-observability.md)                                                            | Logs, tracing, metrics, alerts, dashboards                |
| 20  | [ADR Log](./20-adr.md)                                                                            | 13 architecture decision records                          |
| 21  | [Repository Structure](./21-repository-structure.md)                                              | Monorepo layout, module layering, tooling                 |
| 22  | [Development Backlog](./22-development-backlog.md)                                                | 59 stories, 14 epics, P0–Future                           |
| 23  | [Sprint Plan](./23-sprint-plan.md)                                                                | Sprint 0 + Sprint 1 (Vertical Slice 1)                    |
| 24  | [Commerce Contract](./24-commerce-contract.md)                                                    | Sprint 8 — commerce + subscription routes and rules       |
| 25  | [Growth Contract](./25-growth-contract.md)                                                        | Sprint 9 — referral graph + rank engine                   |
| 26  | [Compensation Contract](./26-compensation-contract.md)                                            | Sprint 10 — compensation graph, rules, commission runs    |
| 27  | [Automation & Reward Contract](./27-automation-reward-contract.md)                                | Sprint 11 — trigger/action rules, reward grants           |
| 28  | [Analytics & Coach Contract](./28-analytics-coach-contract.md)                                    | Sprint 12 — four dashboards, AI team coach                |
| 29  | [White Label & Country Contract](./29-white-label-country-contract.md)                            | Sprint 13 — branding, localisation, legal, tax            |
| 30  | [Public API & Webhooks Contract](./30-public-api-webhooks-contract.md)                            | Sprint 14 — webhooks, API keys, manifest                  |
| 31  | [Enterprise SSO & the Dedicated-Database Path](./31-sso-tenant-database-contract.md)              | Sprint 15                                                 |
| 32  | [Tenant Migration Runbook](./32-tenant-migration-runbook.md)                                      |                                                           |
| 33  | [Spec Coverage](./33-spec-coverage.md)                                                            | what is built, what is not, and what is unproven          |
| 34  | [Feature test session](./34-feature-test-2026-08-21.md)                                           | 2026-08-21                                                |
| 35  | [Scheduler Contract](./35-scheduler-contract.md)                                                  | Sprint 16                                                 |
| 36  | [Observability Contract](./36-observability-contract.md)                                          | Sprint 17                                                 |
| 37  | [Team Knowledge Contract](./37-team-knowledge-contract.md)                                        | Sprint 18                                                 |
| 38  | [Running More Than One Instance](./38-second-instance-contract.md)                                | Sprint 19                                                 |
| 39  | [Restore Drill Contract](./39-restore-drill-contract.md)                                          | Sprint 20                                                 |
| 40  | [Migration Rehearsal at Volume](./40-migration-rehearsal-contract.md)                             | Sprint 21                                                 |
| 41  | [The Outbox at Rate](./41-outbox-rate-contract.md)                                                | Sprint 22                                                 |
| 42  | [Alerting Contract](./42-alerting-contract.md)                                                    | Sprint 23                                                 |
| 43  | [Handlers That Wait](./43-handlers-that-wait-contract.md)                                         | Sprint 24                                                 |
| 44  | [Multi-brand Marketplace Contract](./44-marketplace-contract.md)                                  | Sprint 25                                                 |
| 45  | [Corporate Wellness Contract](./45-corporate-wellness-contract.md)                                | Sprint 26                                                 |
| 46  | [Partner Portal Contract](./46-partner-portal-contract.md)                                        | Sprint 27                                                 |
| 47  | [The API Describes Itself](./47-api-catalog-contract.md)                                          | Sprint 28                                                 |
| 48  | [The Door Everyone Can Knock On](./48-auth-throttle-contract.md)                                  | Sprint 29                                                 |
| 49  | [The Tiers That Were Only Ever Written Down](./49-rate-tier-contract.md)                          | Sprint 30                                                 |
| 50  | [The Output Check That Was Only a Sentence](./50-ai-output-safety-contract.md)                    | Sprint 31                                                 |
| 51  | [Two Sentences in docs/11 That Were Not True](./51-outbox-truth-contract.md)                      | Sprint 32                                                 |
| 52  | [The Matrix That Described a Different Product](./52-permission-matrix-drift.md)                  | Sprint 34                                                 |
| 53  | [A Role for Platform Reads](./53-platform-role-contract.md)                                       | Sprint 35                                                 |
| 54  | [CRM contact encryption](./54-crm-encryption-readiness.md)                                        | rehearsed, not performed                                  |
| 55  | [Duplicate leads, and the index that makes the check survive encryption](./55-duplicate-leads.md) | Sprint 37                                                 |
| 56  | [The prospecting workbook](./56-prospecting-workbook.md)                                          | Sprint 38                                                 |
| 57  | [The workbook, end to end — what gets built and in what order](./57-workbook-roadmap.md)          | Sprint 39                                                 |
| 58  | [The monthly goal sheet](./58-business-goals.md)                                                  | Sprint 39                                                 |
| 59  | [The tracking sheets — one engine, three sheets](./59-tracking-sheets.md)                         | Sprint 40                                                 |
| 60  | [The daily checklist](./60-daily-checklist.md)                                                    | Sprint 41                                                 |
| 61  | [The weekly review](./61-weekly-update.md)                                                        | Sprint 42                                                 |
| 62  | [The performance ladder — 6% · 9% · 12% · 15% · 18% · 21%](./62-performance-ladder.md)            | Sprint 43                                                 |
| 63  | [Starting the business](./63-starting-the-business.md)                                            | Sprint 44                                                 |

## Canonical stack (see ADRs)

pnpm + Turborepo monorepo · Next.js 15 (App Router, Tailwind, PWA, next-intl th/en) ·
NestJS 11 modular monolith · PostgreSQL 17 + Prisma (uuid v7, timestamptz everywhere,
`tenant_id` + RLS via `app.tenant_id`) · Redis + BullMQ · Cloudflare R2 ·
provider-agnostic AI Gateway (Anthropic first).

## The one rule above all

> Membership is the center. Team is the organizational structure. Knowledge drives trust.
> Healthy Living drives value. AI drives intelligence. Commerce supports the journey.
> Compensation is optional and configurable. **Everything is tenant-aware.**
