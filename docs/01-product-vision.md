# 01 — Product Vision

> **AVIORA** — _The Operating System for Membership-Driven Healthy Living Communities._
>
> Status: Approved · Last updated: 2026-08-19 · Source of truth: MASTER AI CODING PROMPT (spec §1–§2, §5, §85)

---

## 1. What AVIORA Is

AVIORA is a **multi-tenant Membership, Healthy Living & Growth Operating System** — a reusable SaaS platform on which many independent organizations run their own ecosystem of:

- **Membership** — plans, entitlements, member lifecycle
- **Healthy Living** — wellness goals, habits, journeys (education-first, never diagnostic)
- **Knowledge** — a knowledge graph connecting health goals → topics → ingredients → evidence → products
- **Learning** — courses, learning paths, certifications, AI tutoring
- **Teams** — unlimited-depth organizational structures with independent leadership
- **Community** — feeds, groups, challenges, recognition
- **Commerce** — catalog, subscriptions, membership pricing (supports the journey; never leads it)
- **Leadership** — growth journeys, rank progression, mentoring
- **Rewards** — configurable, decoupled from monetary compensation
- **AI** — permission-aware assistants and coaches across every domain

Long-term positioning:

> **Healthy Living, Knowledge, Community, Business and Growth — powered by AI.**

AVIORA is **not simply an MLM application**. It is a configurable operating system. Compensation is one optional, tenant-configurable module among eighteen domains — never the center of gravity.

## 2. Core Philosophy — The 14 Principles

Every product, architecture, and UX decision must be defensible against these principles (spec §2):

| #   | Principle                                                                   | Practical consequence                                                                          |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | **People first**                                                            | Member 360 profile is the anchor entity; features serve the person, not the funnel.            |
| 2   | **Membership first**                                                        | `MembershipPlan → Membership → Entitlements` gates capabilities — not hard-coded tiers.        |
| 3   | **Knowledge before product**                                                | Search and content journeys rank knowledge above products, always.                             |
| 4   | **Healthy Living before commerce**                                          | Wellness journeys exist independently of any purchase path.                                    |
| 5   | **Community before network**                                                | Community graph is separate from and prior to referral/compensation graphs.                    |
| 6   | **Growth before compensation**                                              | Growth journey stages ship in MVP; compensation ships in Phase 3, optional per tenant.         |
| 7   | **Education before promotion**                                              | Learning OS is an MVP module; promotional tooling is not.                                      |
| 8   | **Trust before selling**                                                    | Product Intelligence carries evidence context, safety notes, and source verification.          |
| 9   | **Product is a solution, not the destination**                              | The knowledge journey ends at product; it never begins there.                                  |
| 10  | **AI assists people; AI does not replace human responsibility**             | AI outputs are suggestions with context, never autonomous decisions over people.               |
| 11  | **Every organization can configure its own operating model**                | Lifecycle stages, pipelines, growth paths, roles, plans — all config, not code.                |
| 12  | **Data must remain tenant-isolated**                                        | `tenant_id` on every tenant-owned row, Postgres RLS, isolated storage paths, AI/RAG isolation. |
| 13  | **Every business rule must be configurable**                                | Rules live in configuration entities and rule engines, never in `if (tenant === ...)`.         |
| 14  | **Architecture must support future scale without over-engineering the MVP** | Modular monolith now; extractable modules later; no microservices until measurably needed.     |

## 3. Target Tenant Types

AVIORA serves organizations that operate through membership, healthy living, knowledge, learning, community, coaching, team building, referral, affiliate, direct selling, network commerce, leadership development, subscription commerce, and member/business growth (spec preamble, §5):

| Tenant type                 | Typical shape                                          |
| --------------------------- | ------------------------------------------------------ |
| Wellness Business           | Health-focused products/services with member education |
| Membership Club             | Tiered membership with benefits and community          |
| Network Community           | Team-structured community with growth journeys         |
| Coaching Organization       | Coach-led programs, mentoring, learning paths          |
| Affiliate Organization      | Referral-driven growth, affiliate links, rewards       |
| Direct Selling Organization | Team building + optional compensation plans            |
| Academy                     | Learning-first: courses, certifications, cohorts       |
| Corporate Wellness          | Employer-sponsored healthy-living programs             |
| Creator Community           | Creator-led knowledge + community + commerce           |
| Retail Membership           | Store loyalty/membership with subscriptions            |
| Hybrid Organization         | Any combination of the above                           |

A small organization must be able to start with **20 members**, while the same architecture eventually supports tenants with **hundreds of thousands of members** and deeply nested team structures.

## 4. Long-Term North Star (spec §85)

The destination is the **Healthy Living Growth OS**: a multi-tenant platform where each organization composes its own ecosystem of Membership + Healthy Living + Knowledge + Learning + Teams + Community + Commerce + Leadership + Rewards + AI.

The strongest moat is compounding, tenant-isolated intelligence:

```text
Member Graph + Team Graph + Knowledge Graph + Product Graph
+ Learning Graph + Community Graph + Behavior Data + AI Intelligence
```

The platform should eventually answer, for every member and with full permission awareness:

- Who is the member? What are their goals?
- What do they need to learn? What Healthy Living journey are they following?
- What team are they part of? Who is their leader or mentor?
- What content is relevant? What product is relevant?
- What task should they do next? What milestone are they close to?
- How can AI help them progress?

The guiding hierarchy (spec, final instruction):

> Membership is the center. Team is the organizational structure. Knowledge drives trust. Healthy Living drives value. AI drives intelligence. Commerce supports the journey. Compensation is optional and configurable. Everything is tenant-aware.

## 5. What AVIORA Is NOT

Explicit negative scope — the platform must **never** be hard-coded for:

- ❌ One company, brand, or team (brand-neutral by architecture; the first brand is only an initial dataset — adding a second brand requires zero schema changes)
- ❌ One compensation plan or network marketing model (compensation is an optional rule-engine-driven module)
- ❌ One country, language, currency, or timezone (Thai + English from day 1; multi-country model built in)
- ❌ One product catalog or organization structure (unlimited teams, unlimited depth, tenant-defined types)
- ❌ One member lifecycle or growth path (all stages are tenant configuration)

And AVIORA is not:

- ❌ **An MLM app** — network commerce is one supported operating model among many; the platform leads with membership, knowledge, and healthy living.
- ❌ **A medical system** — it does not diagnose disease, make unsupported medical claims, or replace professional care; health recommendations carry appropriate safety context, and health data has stronger privacy protection than any other domain.
- ❌ **A commerce-first marketplace** — the customer journey starts at questions and knowledge, not at a product grid.
- ❌ **A microservices platform (yet)** — it is a modular monolith with domain events; services are extracted only when a measurable scaling reason exists.
- ❌ **A single-tenant custom build** — every feature must work for Tenant N+1 with configuration alone.

## 6. Product Slogan Stack

| Layer               | Statement                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| Codename            | AVIORA                                                                     |
| Tagline             | The Operating System for Membership-Driven Healthy Living Communities.     |
| Positioning         | Healthy Living, Knowledge, Community, Business and Growth — powered by AI. |
| North star          | Healthy Living Growth OS                                                   |
| Optimization target | Fast MVP + Correct Architecture + Long-term Extensibility                  |

## 7. Related Documents

- [02-domain-map.md](./02-domain-map.md) — the 18 domains and their relationships
- [06-member-lifecycle.md](./06-member-lifecycle.md) — configurable member journey
- [14-mvp-scope.md](./14-mvp-scope.md) — precise MVP boundary
- [15-mvp-user-journey.md](./15-mvp-user-journey.md) — the three vertical slices
