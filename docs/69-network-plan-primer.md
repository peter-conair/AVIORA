# 69 · Stairstep–breakaway plans — a domain primer

> **This document seeds nothing.** It is a reference for the people building
> the compensation engine, written because docs/26 forbids hard-coding a plan
> and that prohibition is only safe if we understand the plans well enough to
> know the vocabulary covers them. Amway's is used as the worked example — it
> is the oldest and best-documented plan of this family, not a target tenant.
>
> Figures here are the classic Thailand-market scale and are **illustrative**.
> Every market publishes its own, and they are revised. Nothing downstream may
> read a number from this file; §5 explains why that is not a formality.

## 1. Two currencies, and why there are two

A stairstep plan needs to separate _how much was sold_ from _how much is paid
on it_, so the family splits every product into two figures:

|                          | Purpose                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| **PV** — Point Value     | Ranks the member. Decides which rung of the ladder they reached. |
| **BV** — Business Volume | The money basis. The percentage from the ladder multiplies this. |

The split exists so that price changes and currency differences do not move
people up and down the ladder. A market can reprice a product — BV moves, PV
does not — and nobody's rank shifts because of an exchange rate. It also lets
one plan operate across countries whose prices have no fixed relation.

The engine already has this shape and does not need to learn it: `downline_volume`
is a metric, and a payout that is a `percentage` names its own basis. What it
must not do is assume the metric that qualifies is the metric that pays.

## 2. The ladder is a rank, recomputed monthly

Group PV in a calendar month buys a percentage:

| Group PV / month | Rate |
| ---------------- | ---- |
| 200              | 3%   |
| 600              | 6%   |
| 1,200            | 9%   |
| 2,400            | 12%  |
| 4,000            | 15%  |
| 7,000            | 18%  |
| 10,000           | 21%  |

This is exactly what docs/62 models — six rungs (the business rarely talks
about 3%), qualified on `downline_volume` over a `calendar_month`, requalifying
because a performance level is re-earned rather than kept. That doc seeds the
**shape with a zero threshold and `status: 'draft'`**, and `PATCH /ranks/:id`
refuses to activate a rank whose thresholds are all zero. The table above is
what a tenant would type into that form. It is not what the seed contains, and
the guard is the reason it cannot quietly become so.

## 3. Differential — the payout is a subtraction

The mechanic that makes the family what it is: a member is paid their own rate
**minus the rate already paid to the leg the volume came through**.

```
you  21%  ·  your leg  15%   →  you receive 6% of that leg's BV
you  21%  ·  your leg   9%   →  you receive 12% of that leg's BV
```

Two consequences worth stating, because both have bitten implementations:

- **The payout is not a function of the payee alone.** It needs the downline's
  own achieved rate in the same period. A calculator that resolves a member's
  rank and then multiplies has computed the wrong number.
- **Order matters.** Every leg must be resolved before any differential is
  paid, so ranking is a full pass over the period, then payout is a second
  pass. Streaming one member at a time cannot be made correct by trying harder.

Retail margin — the gap between the member price and what a customer pays — sits
outside all of this and is the first income in the plan. It involves no
downline at all, which is the single most misrepresented fact about these plans.

## 4. Breakaway — the part that is genuinely hard

When a leg reaches the top rung (21%), it **breaks away**: its volume stops
counting toward the upline's group PV, and the differential on it stops. In its
place the upline receives a **Leadership Bonus** (~4% of that leg's BV), plus,
at higher pins, bonuses computed over legs further down.

This is why the pin ladder above 21% counts **legs, not volume**:

| Pin                                                            | Roughly                                              |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| Silver Producer                                                | 21% for one month                                    |
| Gold Producer                                                  | three months                                         |
| Platinum                                                       | six months — the first rung that earns depth bonuses |
| Founders Platinum                                              | all twelve months of the business year               |
| Sapphire / Founders Sapphire                                   | multiple qualified legs                              |
| Emerald                                                        | three breakaway legs                                 |
| Diamond                                                        | six                                                  |
| Executive / Double / Triple Diamond → Crown → Crown Ambassador | more, and sustained                                  |

Then annual bonuses layered on top: Ruby (on volume that did _not_ pass through
a 21% leg), Foster/Depth, Emerald, Diamond, and growth incentives measured
against the previous year.

Breakaway is the reason a stairstep plan cannot be modelled as unilevel with
different numbers. Group volume is **not** the subtree sum; it is the subtree
sum minus every subtree that crossed a threshold _in that same period_. The
excluded set is decided by the period being calculated, so it cannot be cached
on the edge, and it changes retroactively when a leg qualifies late in a month.

## 5. Does the engine express this? — the honest answer

docs/26 §1 claims all eleven bonus types are one sentence: conditions → payout.
Checked against this family:

| Mechanic                            | Covered by docs/26 vocabulary?                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ladder rank on monthly group volume | **Yes.** docs/25 rank rules, docs/62 ladder.                                                                                                                                                         |
| Retail margin                       | **Yes.** Outside the engine entirely.                                                                                                                                                                |
| Leadership bonus on a qualified leg | **Yes.** A condition on the leg's rank, a percentage payout.                                                                                                                                         |
| Pin levels counting qualified legs  | **Probably.** Needs a metric that counts legs meeting a condition, not volume. Worth confirming before claiming it.                                                                                  |
| **Differential**                    | **Was no — now yes.** The payout vocabulary was "fixed amount" or "percentage of a basis". A differential is _my rate minus the leg's rate_, and a rate is not a basis: it belongs to somebody else. |
| **Breakaway exclusion**             | **Was no — now yes.** `downline_volume` walked the compensation graph and summed. Nothing in the condition vocabulary subtracted a subtree because that subtree had qualified.                       |

The two gaps were the same gap wearing two hats: **a rule needs to read the
resolved state of a member other than the payee, in the period being
calculated.** That is a change to the evaluation model — two passes instead of
one — not another `bonus_type`.

docs/26 §1 already said what to do about it: _"If a future bonus genuinely
cannot be expressed this way, that is a signal to extend the condition/payout
vocabulary — never to add a branch named after somebody's plan."_ That is what
was done, and **docs/26 §9 is the record of it**. In summary:

- a payout kind **`differential`**, carrying `tiers` — the ladder, in the
  tenant's own numbers — and paying, per leg, the payee's rung minus the leg
  head's, on that leg's whole volume
- a condition parameter **`excludeLegsAtOrAboveMinor`** on `downline_volume`,
  with the threshold the tenant names

Both are plan-shaped in _form_ and plan-neutral in _value_: a unilevel tenant
never sets them, and a binary tenant sets neither. That is the line docs/26
draws, and it survives.

### The part worth reading twice

**Breakaway was not implemented. It falls out of the subtraction.**

A leg that has reached the payee's own rung has a flat step between them, so
`rate(me) − rate(leg)` is zero and the differential on that line ends by
arithmetic. `excludeLegsAtOrAboveMinor` handles the other half — which legs
count toward the volume that decides _my_ rung — and the two compose into the
mechanic §4 describes without either of them containing the word.

That is the test of whether the extension was the right shape. An engine that
needed a `breakaway` flag would have been a plan in the code with a general name
on it.

### What it cost

Every run now resolves **all** members before paying **any**, and pays that cost
whether or not the plan uses a differential. The alternative — resolving lazily
inside the paying loop — would let member id order decide an amount. docs/26 §9
argues it out.

## 6. Why this matters legally, and therefore structurally

These plans pay on **product volume**, not on recruitment fees. That is the
distinction regulators use, and it is a structural claim about the data: if
`downline_volume` could be satisfied by anything other than a sale, the engine
would model something the tenant may not lawfully operate.

So the sentence "compensation is optional and configurable" has a second half
that is not optional at all: whatever a tenant configures, the basis is volume
that came from a transaction. A future condition vocabulary that lets a rule
count _members_ rather than _volume they sold_ would need a very deliberate
argument, and this paragraph is where it should be answered.

## 7. What this document refuses

- **No thresholds in code.** §2's table is illustrative and stays that way.
  docs/62 §2 gives the reason: a number in the codebase looks authoritative
  _because_ it is in the codebase, and it is wrong for everyone but whoever it
  was copied from.
- **No plan named in a seed.** A tenant may name Amway in their own knowledge
  and their own training. The platform seeds structure.
- **No claim to be current.** Rates, pins and bonus names are revised. Anyone
  relying on a figure here for a real calculation should read the operating
  market's own published plan instead.
