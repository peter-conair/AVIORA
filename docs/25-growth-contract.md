# 25 — Referral Graph & Rank Engine Contract (Sprint 9)

> Spec §17–§18 (the graphs are separate), §44 (Rank Engine).
> Phase 3 is the **optional** growth layer. A tenant that does not run ranks or
> referrals never grants the entitlement, and its members never see any of this.

## 1. The rule this sprint exists to protect

Spec §17 is marked **mandatory**:

> Operational Team Tree must NOT equal Referral Tree.
> Referral Tree must NOT equal Compensation Tree.

So the referral graph gets its **own table, its own traversal, and its own
tests**. It shares nothing with `team_closure`. A member can be referred by one
person and report to a different leader, and moving them in either graph must
leave the other untouched — asserted in both directions, because a coupling bug
is invisible until money depends on it.

## 2. Referral graph

```
ReferralRelationship
  tenant_id · referrer_member_id · referred_member_id
  relationship_type    referral | sponsor | introducer | affiliate | mentor_referral
  effective_from · effective_to (null = active) · metadata
```

Rules:

- **One active relationship per (referred member, type).** A member has one
  sponsor at a time; ending a relationship stamps `effective_to` rather than
  deleting it, so history survives.
- **No self-reference**, and **no cycles**: walking up from the proposed
  referrer must never reach the referred member. Checked on write, depth-capped.
- **Nothing cascades from the team graph.** Joining, leaving or moving a team
  never writes here, and vice versa.

Traversal: `upline(memberId, type, maxDepth)` and `downline(...)` over the
active edges only, via recursive CTE with a hard depth cap.

## 3. Rank engine

```
RankDefinition      code · name · level (ordering) · status · requalify_window_days
RankQualification   rank_id · metric · comparator · threshold · window · params
RankProgress        member_id · rank_id (current) · evaluated_at · metrics (snapshot)
RankHistory         member_id · rank_id · achieved_at · lost_at · reason
```

### Metrics are derived, never stored twice

Every metric is computed from data the platform already holds:

| Metric                     | Source                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `personal_volume`          | Paid orders for this member, summed in minor units                                                     |
| `referral_downline_volume` | Paid orders of the member's referral downline (depth-capped)                                           |
| `direct_referrals`         | Active referral edges where the member is the referrer                                                 |
| `qualified_legs`           | Direct referrals whose **line** (that member plus everyone below them) reaches `params.legVolumeMinor` |
| `courses_completed`        | Completed learning progress rows                                                                       |

The volume metrics deliberately say **referral** downline, not "team volume".
Calling it team volume would quietly re-couple the two graphs the spec keeps
apart, and the name is the only thing stopping that.

### Windows

`lifetime` · `rolling_30` · `rolling_90` · `calendar_month`, resolved against
the evaluation instant. Windows are per qualification row, so one rank can
require lifetime volume and rolling activity at once.

### Evaluation

Everything is read **as of `asOf`** — orders, and the shape of the referral
graph itself. An edge ended yesterday is still live when replaying last week.
Without that, a replay disagrees with the original run and neither can be
trusted, which defeats the point of replaying at all.

`evaluate(memberId, asOf)`:

1. computes each metric the tenant's rank definitions actually reference
   (nothing else is queried),
2. finds the **highest `level`** whose qualifications all pass,
3. writes `RankProgress` (current rank + the metric snapshot that justified it),
4. appends `RankHistory` **only when the outcome changes**, and emits
   `RankAchieved` or `RankLost`.

Idempotent and reproducible: the same `asOf` over the same source data produces
the same rank and no duplicate history. That is what makes a later commission
run auditable — it can be replayed.

### Current rank vs recognition

`RankProgress.rankId` is always the **currently qualified** rank, recomputed at
every evaluation, and it goes **down** when the data stops supporting it. A rank
left in that field after its rules stopped passing would mean a later commission
run pays on a qualification that is no longer true.

Recognition — the best rank ever held — is derivable from `RankHistory` and is
returned separately by `GET /ranks/me` as `highest`. A tenant that awards a
lifetime title is describing recognition, not qualification, and the two must
never be the same number.

In `RankHistory`, `reason` says how a period **began** (`achieved` the first
time, `requalified` when re-earned) and keeps saying it; `lostAt` says the
period ended. Overwriting the reason on loss would erase the fact that the rank
was ever earned, which is what the history exists to keep.

## 4. Permissions and entitlement

| Key               | Held by              | Scope        |
| ----------------- | -------------------- | ------------ |
| `referral.view`   | MEMBER (own), LEADER | `SELF`       |
| `referral.manage` | owner                | `TENANT_ALL` |
| `rank.view`       | MEMBER (own), LEADER | `SELF`       |
| `rank.manage`     | owner                | `TENANT_ALL` |

Entitlement `growth.ranks` gates the **member-facing** rank and referral views,
following the rule settled in docs/24 §2: entitlements come from a member's
plan, so administration and evaluation are permission-scoped only — otherwise a
tenant owner, who holds no plan, could not configure the ranks they sell.

## 5. Routes

| Method   | Path                  | Permission        | Notes                                                                                                                                      |
| -------- | --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/referrals/me`       | `referral.view`   | `referrer` (the sponsor edge) plus `referrers` (every type — a member can have a sponsor and a mentor at once) and their direct referrals. |
| `GET`    | `/referrals/downline` | `referral.view`   | Depth-capped, active edges only.                                                                                                           |
| `POST`   | `/referrals`          | `referral.manage` | `{ referrerMemberId, referredMemberId, type }`. Rejects self-reference, cycles, and a second active edge of the same type.                 |
| `DELETE` | `/referrals/:id`      | `referral.manage` | Ends the edge (stamps `effective_to`).                                                                                                     |
| `GET`    | `/ranks`              | `rank.view`       | Rank ladder for the tenant.                                                                                                                |
| `POST`   | `/ranks`              | `rank.manage`     | Definition + its qualification rows.                                                                                                       |
| `GET`    | `/ranks/me`           | `rank.view`       | Current rank, next rank, and **what is missing** — the spec §44 dashboard.                                                                 |
| `POST`   | `/ranks/evaluate`     | `rank.manage`     | `{ memberId? , asOf? }` — one member or the whole tenant.                                                                                  |

`GET /ranks/me` returns, for each unmet qualification, the metric, the
threshold, and the member's current value. "You need 2 more qualified legs" is
the only form of this that is any use to a member.

## 6. Events

`ReferralCreated`, `ReferralEnded`, `RankAchieved`, `RankLost` — appended to the
outbox in the same transaction as the write. Gamification can already reward
`RankAchieved` with no code change.

## 7. Out of scope for this sprint

- **Compensation and commissions** (Sprint 10). Nothing here computes money;
  rank is an input to that, not a payer.
- **The compensation graph**, which is a third graph again. It is not the
  referral graph, and this sprint does not create it.
- Scheduled re-evaluation. `POST /ranks/evaluate` exists; nothing calls it on a
  timer yet, the same gap as subscription renewal.
