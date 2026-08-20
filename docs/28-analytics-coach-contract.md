# 28 — Analytics & AI Team Coach Contract (Sprint 12)

> Spec §53 (Analytics OS), §49 (AI Team Coach), §50 (authorization before
> retrieval).

## 1. One set of numbers, four audiences

Spec §53 asks for four dashboards — member, leader, tenant, platform. They are
**not four analytics systems**. Each is the same derived measures at a different
scope, and the scope is enforced by the same machinery every other module uses:

| Dashboard | Scope source                                      | Permission              |
| --------- | ------------------------------------------------- | ----------------------- |
| Member    | the caller's own member id                        | `analytics.self.view`   |
| Leader    | `TeamScopeService` — the teams they actually lead | `team.analytics.view`   |
| Tenant    | the whole tenant                                  | `analytics.tenant.view` |
| Platform  | across tenants                                    | `platform.metrics.view` |

Nothing is stored. Every measure is computed from the domains that already own
the data — members, orders, learning, goals, community, ranks, commissions. A
metric that needed its own table would be a metric that can disagree with the
thing it measures.

## 2. Health data is not in any of them

Habits, metrics and health profiles are **absent from the leader, tenant and
platform dashboards entirely** — not aggregated, not counted, not averaged.

This is stricter than it may look, and deliberately so. An average over a small
team is an identification: "average sleep 4.5 hours" across two people tells a
leader something about a specific person, and docs/13 says health data crosses
to another person only through that member's explicit grant. There is no
aggregate exemption, because aggregates of small groups are not anonymous.

The member's _own_ dashboard may show their own health summary — it is theirs.

## 3. Definitions, stated once

Measures nobody can define the same way twice are worse than no measures:

| Term              | Definition used everywhere                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Active member** | a member with at least one recorded action (goal, learning, order, post, habit log — the _existence_, never the content) in the window |
| **New member**    | `joinedAt` inside the window                                                                                                           |
| **Retention**     | of members who joined in cohort month _M_, the share still active in the window                                                        |
| **Churn**         | members whose membership ended or lapsed in the window, over the members active at its start                                           |
| **Growth**        | change in active members between two equal, adjacent windows                                                                           |
| **Engagement**    | posts, comments and reactions per active member                                                                                        |

Every dashboard response states the window it used and the definitions it
applied. A number without its window is a number that will be misquoted.

## 4. The AI Team Coach answers from these numbers

Spec §49 lists eight questions. Each maps to measures this module already
computes, for the leader's own scope:

| Question                                | Answered from                                  |
| --------------------------------------- | ---------------------------------------------- |
| Which team is growing fastest?          | growth per team in scope                       |
| Which team needs support?               | lowest growth / lowest active share            |
| Which leader needs coaching?            | leaders of teams whose engagement fell         |
| Which member is inactive?               | members with no recorded action in the window  |
| Who is close to the next milestone?     | rank progress — smallest remaining requirement |
| Which course should the team take next? | least-completed course among assigned          |
| What should this team focus on?         | the weakest measure, named                     |
| What activities correlate with growth?  | honest refusal — see §6                        |

**Authorization happens before retrieval, not after** (spec §50). The coach
does not query the database; it calls the same scoped analytics service the
leader dashboard calls, with the same actor. There is no code path by which it
can see a team the leader cannot, so there is nothing to filter afterwards.

The coach's answer names the numbers it used. An AI answer a leader cannot
check is an answer they should not act on.

## 5. Routes

| Method | Path                  | Permission              | Notes                                                                |
| ------ | --------------------- | ----------------------- | -------------------------------------------------------------------- |
| `GET`  | `/analytics/me`       | `analytics.self.view`   | The member's own dashboard, health included.                         |
| `GET`  | `/analytics/team`     | `team.analytics.view`   | Scoped to teams the caller leads. No health.                         |
| `GET`  | `/analytics/tenant`   | `analytics.tenant.view` | Whole tenant. No health.                                             |
| `GET`  | `/analytics/platform` | `platform.metrics.view` | Across tenants; platform roles only.                                 |
| `POST` | `/ai/coach/team`      | `team.analytics.view`   | `{ question }` — one of the eight, answered from the caller's scope. |

All accept `?window=30d|90d|month` and echo the resolved window back.

## 6. What this sprint refuses to guess

- **"What activities correlate with growth?"** is answered with a plain refusal
  and the reason: correlation over a handful of teams and a few weeks is noise
  presented as insight. It returns the underlying series so a leader can look,
  and says the platform will answer it when there is enough history to mean
  anything.
- **No AI cost or infrastructure cost** on the platform dashboard: nothing
  meters them yet, and a fabricated cost is worse than a missing one. The
  dashboard names them as not-yet-measured rather than showing zero.
- **No churn prediction, no scoring of people.** Spec §49 asks which leader
  needs coaching; the honest answer names a measure that fell, not a judgement
  about a person.
