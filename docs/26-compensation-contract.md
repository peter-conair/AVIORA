# 26 — Compensation Rule Engine Contract (Sprint 10)

> Spec §42 (Compensation OS), §43 (Compensation Rule Engine), §45 (Reward OS).
> Spec §42 opens with the constraint that governs everything here:
> **"Compensation must be optional and tenant configurable. Never hard-code one
> network plan."**

## 1. The eleven bonus types are configurations, not code paths

Spec §43 lists eleven bonuses — fixed cash, percentage, milestone, rank,
leadership, growth, matching, referral, team, requalification, come back. It
would be a mistake to write eleven calculators. Every one of them is the same
sentence:

```
IF   <conditions on the member's metrics>
THEN <payout: a fixed amount, or a percentage of some basis>
```

So the engine has **conditions** and **two payout kinds**, and `bonus_type` is
a _label_ carried through to reporting. A tenant that invents a twelfth bonus
writes rows, not a release. If a future bonus genuinely cannot be expressed
this way, that is a signal to extend the condition/payout vocabulary — never to
add a branch named after somebody's plan.

## 2. The compensation graph is the third graph

Spec §17 lists Team, Referral, **Compensation**, Mentor and Community as
separate graphs. Sprint 9 proved team ≠ referral; this sprint adds the third
and holds the same line:

```
CompensationRelationship
  tenant_id · upline_member_id · downline_member_id
  effective_from · effective_to (null = active)
```

Its own table, its own traversal, no reads of `team_closure` or
`referral_relationships`. A member may be **referred** by one person and **paid
under** another — that is the normal case in a plan with placement, not an edge
case. Same write guards as the referral graph: no self-reference, no cycles,
one active upline at a time, ending stamps `effective_to`.

Compensation metrics traverse the **compensation** graph. Referral metrics
traverse the referral graph. The calculator shell is shared; the graph it walks
is a parameter, never a default.

## 3. Plans and rules

```
CompensationPlan   code · name · currency · status · effective_from/to
CompensationRule   plan_id · code · name · bonus_type (label) · priority
                   conditions (JSON array) · payout (JSON) · status
```

A **condition** reuses the Sprint 9 vocabulary exactly — metric, comparator,
threshold, window, params — plus `graph` (`compensation` by default,
`referral` where a rule really means the referral line). The downline metric is
spelled `downline_volume` and takes its graph from the condition;
`referral_downline_volume` survives from Sprint 9 as an alias pinned to the
referral graph, since a metric whose NAME fixes a graph leaves the graph
parameter nothing to do.

Reusing the Sprint 9 vocabulary is the point: a rank rule and a bonus rule that both say "personal volume ≥ 50,000"
must compute the same number, or the plan is lying to somebody.

A **payout** is one of:

| kind      | fields                                  | meaning                                     |
| --------- | --------------------------------------- | ------------------------------------------- |
| `fixed`   | `amountMinor`                           | a flat amount in the plan's currency        |
| `percent` | `percent`, `basis`, optional `capMinor` | `round(basis × percent / 100)`, then capped |

`basis` is a metric name, computed with the same calculator as conditions, so
"5% of downline volume" cannot mean one thing in the condition and another in
the payout. `basisWindow` and `basisGraph` say which window and which graph;
**the window defaults to the run's own period**, because a percentage of
_lifetime_ volume pays for the same sales again in every period, for ever. A
plan that really means all-time has to say `lifetime` out loud.

The window vocabulary therefore gains `period` on top of the Sprint 9 set. It
resolves against the run being computed, and degrades to lifetime for any
caller that has no period — rank evaluation, for instance.

All money is integer **minor units**. Percentages round with `Math.round`, once,
at the point of calculation — never on a value that has already been rounded.

## 4. Commission runs

```
CommissionRun    plan_id · period_start · period_end · status · totals · created_at
CommissionEntry  run_id · member_id · rule_id · bonus_type · amount_minor
                 basis (JSON: the exact numbers that produced the amount)
```

Rules, in order of importance:

- **A run is a snapshot of a period.** `UNIQUE (tenant_id, plan_id,
period_start, period_end)` — asking twice for the same period returns the
  same run, never a second one. This is the same defence the subscription
  renewal uses, and for the same reason: the second row is a second payout.
- **Draft is recomputable; approved is immutable.** While `status = 'draft'` a
  run may be recomputed in place (entries replaced). Once `approved`, nothing
  in it may change — a recompute request against an approved run is refused,
  not silently ignored.
- **Every entry shows its working.** `basis` stores the metric values and the
  rule's thresholds as they were at computation time, so an entry can be
  explained a year later without re-running anything.
- **Reproducible.** A run computes as of `period_end`, using the as-of graph
  traversal from Sprint 9. Recomputing a draft over unchanged source data
  produces identical entries.

`CommissionEarned` is emitted per entry on approval, not on draft computation —
a draft is a proposal, and nothing downstream should react to a proposal.

## 5. Rewards are not commissions

Spec §45: _"Separate reward from monetary commission."_ Points and badges
already exist in the gamification module and stay there. This sprint adds no
reward types; a rule that grants a badge belongs to gamification, which is
already driven by events and can react to `CommissionEarned` without any code
here. Keeping money in one module and recognition in another is what stops a
tenant from accidentally paying cash for a badge rule.

## 6. Permissions and entitlement

| Key                   | Held by             | Scope        |
| --------------------- | ------------------- | ------------ |
| `compensation.view`   | MEMBER (own), owner | `SELF`       |
| `compensation.manage` | owner               | `TENANT_ALL` |

Entitlement `growth.compensation` gates the **member-facing** earnings view
only. Plan configuration and run execution are permission-scoped, per the rule
settled in docs/24 §2 — a tenant owner holds no membership plan.

**A tenant with compensation disabled sees no surface at all**: no plan, no
rules, no runs, and `/compensation/me` answers `ENTITLEMENT_REQUIRED`. Nothing
about the module appears for a tenant that never configured one.

## 7. Routes

| Method   | Path                               | Permission            | Notes                                                                   |
| -------- | ---------------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `GET`    | `/compensation/plans`              | `compensation.manage` | Plans with their rules.                                                 |
| `POST`   | `/compensation/plans`              | `compensation.manage` | Plan + rules in one call.                                               |
| `POST`   | `/compensation/plans/:id/rules`    | `compensation.manage` | Add a rule to an existing plan.                                         |
| `GET`    | `/compensation/runs`               | `compensation.manage` | Runs with totals.                                                       |
| `POST`   | `/compensation/runs`               | `compensation.manage` | `{ planId, periodStart, periodEnd }`. Idempotent.                       |
| `POST`   | `/compensation/runs/:id/recompute` | `compensation.manage` | Draft only; refuses on an approved run.                                 |
| `POST`   | `/compensation/runs/:id/approve`   | `compensation.manage` | Freezes it and emits `CommissionEarned` per entry.                      |
| `GET`    | `/compensation/runs/:id/entries`   | `compensation.manage` | Every entry with its `basis`.                                           |
| `GET`    | `/compensation/me`                 | `compensation.view`   | The caller's own approved entries, with the numbers that produced each. |
| `POST`   | `/compensation/graph`              | `compensation.manage` | Place a member under an upline.                                         |
| `DELETE` | `/compensation/graph/:id`          | `compensation.manage` | Ends the placement.                                                     |
| `GET`    | `/compensation/graph`              | `compensation.manage` | The placement graph, active or including ended.                         |

`/compensation/me` shows **approved** entries only. A member should never see a
number that has not been signed off.

## 8. Events

`CommissionRunCreated`, `CommissionRunApproved`, `CommissionEarned` (per entry,
on approval), `CompensationPlacementCreated`, `CompensationPlacementEnded`.

## 9. The vocabulary was extended once, and this is the record of it

§1 claimed all eleven bonus types are one sentence — conditions, then a fixed
amount or a percentage. That claim was tested against the stairstep–breakaway
family (docs/69) and **failed in two places**, both the same failure: `fixed`
and `percent` resolve a payout from the payee alone, and a stairstep plan
cannot. What it owes on a line depends on the rate **that line** reached in the
same period.

No threshold, no bonus type and no extra condition could say that. So §1's own
instruction applied — _"a signal to extend the condition/payout vocabulary —
never to add a branch named after somebody's plan"_ — and the vocabulary grew by
exactly two things:

| Addition                    | Where                    | What it says                                                                                                                    |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `differential` payout kind  | `payout.kind`            | Pay my rate minus the rate the leg already earned, on that leg's volume. Carries `tiers` — the ladder, in the tenant's numbers. |
| `excludeLegsAtOrAboveMinor` | condition/basis `params` | A leg at or above this stops counting toward `downline_volume`.                                                                 |

Three properties make this an extension rather than a plan in the code:

- **A plan that does not use them never mentions them.** Tenant B's milestone
  plan is unchanged, byte for byte, and the two rules that describe it still
  produce the amounts they always did.
- **No number in the ladder is ours.** `tiers` is empty of defaults. A rung is
  a row, refused at write time if the rungs are out of order (nobody could
  check that against their plan document) and if a single rung pays 0% (it
  computes, pays nothing, for ever — docs/62 §3's trap in the other direction).
- **Breakaway is not implemented.** It falls out. A leg on the same rung as the
  payee has a flat step between them, so the subtraction is zero and the
  differential ends. Nothing in the engine says the word.

### The cost: computation is two passes

The one structural change. A run resolves **every** member before it pays
**any**, because a payout that reads another member's resolved rate cannot be
computed in the same loop that resolves it — id order would decide the amount,
and a plan that pays differently on Tuesday is not a plan.

Both passes run for every plan, including plans with no differential rule. A
run that changed shape depending on its rules would be a second engine wearing
the first one's name.

### What is still not expressible

The ladder lives on the rule that uses it, not on the plan. One differential
rule is the normal case; a plan that grows a second one is the moment to hoist
`tiers` to `compensation_plans`, and the shape was chosen so that hoist is a
data move rather than a rewrite.

It is deliberately **not** read from the rank ladder (docs/62), though a tenant
will usually type the same numbers into both. A run must be reproducible from
source data as of its period, and `rank_progress` holds whatever the last
evaluation left there — replaying an old run against it would pay a different
number, and neither figure could then be defended.

## 10. Out of scope for this sprint

- **Paying anyone.** A run produces entries; moving money is a payout provider,
  and the same seam as commerce payments applies.
- **Clawbacks and adjustments.** Real plans need them; they are a second
  entry type, and inventing one before a tenant asks would guess wrong.
- **Scheduled runs.** Runs are triggered; nothing calls them on a timer, the
  same carried gap as subscription renewal and rank evaluation.
