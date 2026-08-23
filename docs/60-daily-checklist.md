# 60 · The daily checklist

## 1. Not a new engine

`DAILY CHECK LIST` is eight things done every day and eight done once a week.
That is a recurring tick with a date on it, which is exactly what the habits
module has stored since Sprint 6 — so this sheet is **seed data and a view**,
not a fourth grid.

docs/57 §8.2 called this in advance. Building a parallel daily-grid table would
have been a second place to record the same fact, which docs/24 already warns
against.

## 2. `cadence: 'weekly'` was a word, not a behaviour

The `Habit` model has had a `cadence` column since Sprint 6, and
`POST /health/habits` has accepted `z.enum(['daily','weekly'])` since then too.

**Nothing anywhere read it.** `logHabit` did `startOfDay(...)` and stopped, so a
weekly habit ticked on Wednesday and again on Friday wrote _two_ logs, and
"weekly" behaved identically to "daily". No test covered it either — the enum,
the column and the API all said the feature existed.

`ChecklistService.logDateFor` is what makes it true: a weekly item normalises to
the **Sunday** that starts its week, so `UNIQUE (habit_id, log_date)` enforces
once a week. Sunday because the sheet's first column is SUNDAY, and getting that
wrong would not look like a bug — it would look like a member who ticked Monday
and found their week empty.

## 3. Two promises that must not share a query

The habits engine was built for health data and carries docs/13's promise:
nobody sees a member's logs without a grant, **not even their leader**.

Business habits invert that on purpose. A coach seeing whether the calls were
made is the entire point of the sheet. Those are opposite promises about rows in
one table, so they are separated by a `category` column and **every query here
filters `category: 'business'` explicitly**. It is not a convention; the whole
boundary rests on that filter.

Proven rather than asserted: a test has a leader read a downline's checklist
with no grant in place, gets the eight business items, and confirms the
member's `water` health habit — created earlier in the same file — is not among
them.

Ticking is `SELF` for everybody, leaders included. **A tick is a claim that you
did the work**; a coach recording it on your behalf would make the sheet
worthless as a record of what happened.

Permissions reuse `tracker.view` / `tracker.manage` rather than minting a third
pair. Both are the coaching sheets, held by the same people, and a permission
nobody can tell apart from its neighbour is a cost with no reader.

## 4. Not audited

`PUT /checklist/items/:id` is the most routine act in the product — eight a day
per member. `habit_logs` already records the date and the member, which is what
an audit row would say, and auditing it would bury the rows that log exists for.
The reason is in `audit-coverage.spec.ts` rather than in someone's memory.

## 5. The screen stays a grid

The follow-up sheets became cards because forty-four columns cannot honestly fit
on a phone. This one stays a **real grid**: seven columns by eight rows does
fit, and seeing the whole week at once _is_ the sheet — a stack of cards would
destroy the only thing it is for.

What that costs: single-letter day headings, so the tap targets stay
thumb-sized. `apps/web/e2e/checklist.spec.ts` asserts the page does not scroll
sideways at 360 px, because that constraint is what the layout is built around.
