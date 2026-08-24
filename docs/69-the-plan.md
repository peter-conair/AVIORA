# 69 · The plan — backwards from the target, forwards to today

## 1. The pieces existed and nothing joined them

A target (docs/58), a name list (docs/56), follow-up sheets (docs/59) and a
weekly review (docs/61) — four screens, none of which answered the question a
member actually has on a Monday:

> **30,000 this month. So how many names is that, and who do I ring today?**

## 2. Backwards

```
target ÷ average order   = customers needed
customers ÷ close rate   = conversations needed
conversations ÷ reach    = names needed
```

The last number is the point. On a realistic set of rates a 30,000 target wants
**two hundred names** — ten times the twenty-row sheet — and nobody works that
out in their head, which is why they run out of people in week three and call it
a motivation problem.

## 3. The rates are the member's own, or nobody's

Every rate is measured from that member's own history. Where there is not enough
history it is **not invented**: an industry figure written here would look
authoritative _because it is in the code_, and it would be wrong for everyone
except whoever it was copied from — the same rule as the ladder's thresholds
(docs/62 §2) and "5+3" (docs/58 §3.2).

`MIN_RATE_SAMPLE = 10`, `MIN_ORDER_SAMPLE = 5`. A conversion rate off two leads
is noise wearing a percentage sign, and a month's plan built on it sends
somebody after the wrong number of people for four weeks. The thresholds are a
judgement — low enough to reach in a first month or two, high enough that one
lucky week does not set the plan — and they are named constants so the judgement
is arguable rather than buried.

Below the threshold the member supplies the number themselves, and the screen
keeps saying it was an estimate. Assumptions live on **the month's goal row**,
because an assumption belongs to the plan it was made for — last March's guess
should not quietly steer this month.

## 4. `null` is not `0`

A funnel step reports `short: null` when the chain broke further up, and
`short: 0` when you genuinely have enough. A screen showing both as _"0 more
needed"_ would be lying about half of them.

For the same reason the response carries `blockedBy` — the single missing number
that would repair the chain — so the screen can ask for that one thing instead
of rendering an empty funnel and leaving somebody to work out what is wrong.

## 5. Forwards

The same endpoint returns today's short list: names on a list with **no score**
first, because a name nobody has rated cannot be planned around and would
otherwise sit unnoticed at the bottom of a list sorted by score; then follow-ups
that are due; then people on a sheet who have never been started.

## 6. Two sessions, one checkout

This sprint was built while another session was redesigning `/prospecting` in
the same working tree, and the collision is worth recording because it will
happen again.

The tab wiring was overwritten mid-sprint: the page became a grouped contents
screen, `PlanTab` stayed imported and was never rendered. Two files —
`messages/*.json` and `lib/types.ts` — held both sessions' edits at once.

The commit was therefore assembled from **`main`'s version of each file plus
only this sprint's changes**, never from the shared working tree. Copying the
tree wholesale is how another session's work ended up under someone else's
commit message once already (`ddecc0e`).

**Still open:** when that redesign lands, `plan` must be added to its section
map. It is one line in a file this sprint deliberately did not touch.
