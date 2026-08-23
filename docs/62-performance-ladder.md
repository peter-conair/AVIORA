# 62 · The performance ladder — 6% · 9% · 12% · 15% · 18% · 21%

## 1. It was already a rank

These are the levels the business talks in, and the Diamond Check List names
three of them (`เป็น 12%`, `ทำ 15+`, `เป็น UNIT12`). A performance level is _the
highest level whose rules all pass, recomputed every month_ — which is precisely
what the rank engine has done since Sprint 9 (docs/25).

So nothing was built to model them. What was missing was smaller and more
embarrassing: **a new tenant had no ladder at all.** `/ranks/me` answered with
`current: null, next: null, missing: []`, and the growth screen — which already
renders the gap to the next level — had nothing to render. The planning half of
this product was complete and unreachable.

## 2. The thresholds are deliberately not in the code

What group volume earns 12% is the business's own number: set by the plan it
operates under, revised by that plan, and different for another tenant.

A figure written here would look authoritative _because it is in the code_, and
it would be wrong for everyone except whoever it was copied from. That is the
same failure as the "5+3" number in docs/58 §3.2, and it gets the same answer:
the system supplies the structure, the tenant supplies its numbers.

The ladder therefore seeds with the right **shape** — six levels, correctly
named and ordered, each qualified on `downline_volume` over a `calendar_month`,
requalifying every 31 days because a performance level is re-earned rather than
kept — and a threshold of zero.

## 3. Which is why it ships switched off

A rank with a zero threshold qualifies **everybody**, instantly. The comment in
the evaluator says a rank with no rules "passes trivially, which is how a tenant
models an entry rank" — true, and lethal for a rung called 21%.

So the seed is `status: 'draft'`, drafts are never evaluated, and
`PATCH /ranks/:id` **refuses to activate a rank whose thresholds are all zero**:

> _This rank has no threshold set, so every member would qualify for it. Set the
> volume it requires before turning it on._

That guard is what makes shipping a blank ladder safe rather than a loaded gun,
and it is a test rather than a convention.

Seeding happens on first read of `/ranks`, and **only into a tenant with no
ranks at all** — a tenant that built its own ladder must not find six draft rows
appear underneath it.

There was also no way to _set_ a threshold before this sprint: ranks could be
created and listed, never edited. `PATCH /ranks/:id` is new, and the admin
screen shows each draft rung with one field and one button.

## 4. The learning path existed and was invisible

`RankDefinition.recommendedCourseIds` has been on the model since Sprint 27, and
`/ranks/me` has returned it on `next` ever since, with a comment explaining that
it answers what §44's dashboard asks.

**No screen ever rendered it.** The web's `RankRef` type did not even declare
the field, so nothing could. The ladder told a member exactly what they were
short of and never what to do about it — which is the whole of _"การเรียนรู้เพื่อ
ให้สำเร็จ"_ missing from a product that had already built both halves.

The growth screen now shows _"เรียนอะไรถึงจะไปถึง"_ under the gap, resolving the
ids against the member's own course list so an id they cannot open renders as
nothing rather than a dead link.

## 5. How it joins up

```
customers buy  →  orders (paid)  →  downline_volume  →  the level
                                          ↑                  ↓
                                     goal sheet         courses to do next
                                    (docs/58)             (docs/27 §3)
```

One metric, one definition, four screens: the goal sheet quotes it, the weekly
review quotes it, the rank engine qualifies on it, and compensation pays on it.
docs/58 §3.1 is why that matters — two screens disagreeing about one month is
the failure the whole arrangement exists to prevent.
