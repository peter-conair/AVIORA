# 33 — Spec Coverage: what is built, what is not, and what is unproven

> A scorecard against all 85 sections of `SPEC-master-prompt.md`, written at
> the end of Phase 4. Its job is to be **checkable**: every "built" names where
> the behaviour lives and what proves it, and every gap says why it is a gap
> rather than an oversight.
>
> Three states are used, and the third matters most:
>
> - **Built** — implemented, tested, and used through the UI at least once.
> - **Deliberately not built** — a decision, with the reason. Not a to-do.
> - **Unproven** — code exists; the claim the spec makes cannot be verified
>   here. These are the ones that would embarrass us in an incident, so they
>   are named individually rather than averaged away.

## 1. Built

| §            | Section                                                        | Where                                            | Proof                                                                                                                   |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1–3          | Vision, philosophy, member journey                             | `docs/01`, `docs/15`                             | The three vertical slices run end to end                                                                                |
| 4–6          | Multi-tenancy, tenant entity, resolution                       | `common/tenant`, RLS on every tenant table       | `tenant-isolation.spec.ts`, route-registry sweep                                                                        |
| 7–10         | User vs member, membership, entitlements, profile              | `modules/identity`, `modules/membership`         | Slice 1 E2E                                                                                                             |
| 11–16        | Team OS, entity, membership, leadership, hierarchy, management | `modules/team` + closure table                   | Slice 2 E2E, cycle-guarded moves                                                                                        |
| 17–18        | **Team tree ≠ referral tree**, referral graph                  | `modules/growth`                                 | `growth.e2e.spec.ts` — independence asserted in both directions                                                         |
| 19–21        | Scopes, team & leader dashboards                               | `TeamScopeService`, `/analytics/team`            | `analytics.e2e.spec.ts`                                                                                                 |
| 24–25        | Learning OS, onboarding                                        | `modules/learning`                               | Slice 1 E2E                                                                                                             |
| 27–28        | Healthy Living OS + its knowledge graph                        | `modules/health`, `modules/knowledge`            | `health.e2e.spec.ts` — consent gate, no admin override                                                                  |
| 29–33        | Knowledge OS, product intelligence, brand neutrality, content  | `modules/knowledge`                              | `knowledge-ai.e2e.spec.ts` — two brands, no favouritism; `team-knowledge.e2e.spec.ts` — team scope applied in the query |
| 34           | CRM                                                            | `modules/crm`                                    | Sprint 3 E2E                                                                                                            |
| 36–38        | Community, challenges, gamification                            | `modules/community`, `challenge`, `gamification` | `community-challenges.e2e.spec.ts`                                                                                      |
| 39–40        | Commerce, subscriptions                                        | `modules/commerce`                               | `commerce.e2e.spec.ts` — renewal cannot double-bill                                                                     |
| 42–45        | Compensation OS, rule engine, ranks, rewards                   | `modules/compensation`, `growth`, `reward`       | `compensation.e2e.spec.ts` — two tenants, two plans, one engine                                                         |
| 46–47, 49–50 | AI OS, context, team coach, knowledge security                 | `modules/ai`, `analytics`                        | Coach holds no DB handle; authorization precedes retrieval                                                              |
| 51           | Automation OS                                                  | `modules/automation`                             | `automation.e2e.spec.ts` — idempotent per event, no self-triggering                                                     |
| 52           | Notification centre                                            | `modules/notification`                           | Sprint 3 E2E                                                                                                            |
| 53           | Analytics OS (4 dashboards)                                    | `modules/analytics`                              | `analytics.e2e.spec.ts`                                                                                                 |
| 54–56        | Multi-language, multi-country, white label                     | `modules/tenant-config`                          | `white-label.e2e.spec.ts`                                                                                               |
| 57–60        | Roles & permissions, security, health privacy, audit           | `common/auth`, `docs/13`                         | Isolation suite; health tests; audit viewer                                                                             |
| 61, 65–67    | Database, events, entities, API design                         | `packages/db`, outbox, `docs/10`                 | `schema-meta.spec.ts` guards every new table                                                                            |
| 68           | Observability                                                  | `common/observability`, `modules/observability`  | `observability.e2e.spec.ts` — stale claims surfaced, cost priced                                                        |
| 69–74        | Testing strategy, MVP, three slices                            | `docs/17`, `apps/api/test`                       | 541 API + 22 browser tests                                                                                              |
| 78–84        | Dev rules, docs, ER, backlog, process, MVP done                | `docs/00`–`docs/33`                              | This suite of documents                                                                                                 |

## 2. Deliberately not built

| §   | What                                                | Why                                                                                                                                                                                                         |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22  | Dream OS as its own module                          | Goals already carry a category and a target. A second goal system would be two places a member's ambitions disagree. The named categories (vision, family, financial…) are goal categories, not new tables. |
| 23  | Growth journey as its own ladder                    | It _is_ the rank engine with different words (docs/27 §3). Two ladders would disagree about what a member achieved.                                                                                         |
| 26  | Task & Activity OS                                  | Habits, follow-ups, goals and challenges already cover the described shapes. A generic Task table on top would duplicate four things that each already know their own rules.                                |
| 30  | Product intelligence beyond evidence & safety notes | Community experience and "alternatives" need data the platform does not have yet.                                                                                                                           |
| 35  | AI CRM (lead priority, next best action)            | Not started. Would need enough CRM history to be worth trusting.                                                                                                                                            |
| 41  | Business OS as a distinct module                    | Its listed capabilities are CRM + commerce + analytics, already present.                                                                                                                                    |
| 48  | The full AI agent roster                            | One assistant and one coach exist. Agents without jobs are ceremony.                                                                                                                                        |
| 62  | Storage (R2/S3 uploads)                             | Nothing in the shipped surface uploads a file yet.                                                                                                                                                          |
| 43  | Payment/payout execution                            | Commerce records payments; compensation computes entries. Moving money needs a provider and a licence conversation, not code.                                                                               |
| 55  | Per-country payment providers, tax filing           | There is no payment provider at all; a country dimension on nothing is ceremony.                                                                                                                            |
| 56  | Native app-store distribution                       | A branded installable PWA ships. Store distribution is a build pipeline and an account per tenant.                                                                                                          |
| 77  | Marketplace, corporate wellness, partner portal     | Phase 4 product surfaces, none started.                                                                                                                                                                     |

## 3. Unproven — code exists, the claim does not hold yet

These are the honest risks. Each names what would make it provable.

| Claim                                                                                                   | State                                                                                                                                                                                                                 | What it needs                                                                                                                      |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **A large tenant can move to a dedicated database with zero data loss** (§61, ADR-002, roadmap Phase 4) | Routing seam, extract/verify tooling and runbook exist (docs/31–32). Never run at volume.                                                                                                                             | A staging rehearsal with a real tenant's data and a measured downtime window.                                                      |
| **Enterprise SSO works with a real IdP**                                                                | OIDC verified against a fake provider in tests.                                                                                                                                                                       | One federated tenant against Entra/Okta/Google, including their clock skew and claim quirks.                                       |
| **The outbox survives production load**                                                                 | In-process poller with backoff. Two relays now race one backlog in `second-instance.e2e.spec.ts` and each handler still runs once.                                                                                    | BullMQ (docs/11) and a load test. Concurrency is proved; RATE is not — nothing has ever run it at volume.                          |
| **Scheduled work happens**                                                                              | Renewals, rank evaluation, commission drafts and the webhook sweep run on a timer, one row per occurrence (docs/35). Two instances now tick the same occurrence in `second-instance.e2e.spec.ts` and produce one row. | An alert on runs left `claimed`. The console shows them (docs/36 §4), but somebody still has to look.                              |
| **AI answers are grounded**                                                                             | Citations and a grounded-local fallback; quota-capped.                                                                                                                                                                | A real provider key, and evaluation against questions with known answers.                                                          |
| **Rate limiting holds**                                                                                 | One budget in Redis, shared across instances (docs/38 §2); falls back to per-process counting when Redis is unreachable.                                                                                              | A deployment that actually runs two instances. The mechanism is proved (`redis-rate-limit.spec.ts`); the operational setup is not. |
| **Backups restore**                                                                                     | Not exercised.                                                                                                                                                                                                        | A restore drill. A backup nobody has restored is a hope.                                                                           |
| **Somebody is watching**                                                                                | The platform reports on itself (docs/36): queue depth, stale scheduler claims, AI spend per tenant.                                                                                                                   | Something that reads those numbers when nobody is looking. A metric with no alert is a page nobody opens.                          |

## 4. The MVP rows

`docs/14` §3 row 16 — the AI respecting _team-level_ knowledge permissions —
was the last one open, and closed in Sprint 18 (docs/37). Knowledge can now be
attached to a team; reading it goes up the tree and publishing it goes down;
and the assistant respects the boundary because retrieval never loads an
article the caller may not read, so there is nothing to filter afterwards.

Row 18 (mobile UX) stays ⚠️ manual on purpose. Playwright runs at Pixel 7 and
asserts no horizontal scroll, but "usable" is a judgement a viewport check does
not make, and turning that row green on the strength of a scroll-width
assertion would claim more than the test proves.
