# 64 · 6WNY — from a checklist to a programme

## 1. What "6WNY" meant before this

One thing: a tracking sheet. Sprint 40 seeded `follow_up_6wny` — 34 checkpoints
across five stages — and that was the _only_ place the string appeared in the
entire system. No course. No product. No measurements.

A programme you cannot learn, cannot buy, and whose results are not recorded is
a checklist wearing a programme's name.

## 2. A column can now ask for a number

The sheet says **"ชั่งน้ำหนัก (kg.)"** at every stage. Recorded as a tick, that
says the scales were used and throws away what they said — which is the only
thing the customer came for.

`tracker_steps.capture_unit` turns a column into a measurement, and
`tracker_marks.value` holds the reading beside the date the mark already
carried. Ten of the 6WNY columns declare a unit (five `kg`, five `cm`); the
other twenty-four stay ticks, because a unit on every column turns a checklist
into a form.

Two behaviours that differ from a tick, on purpose:

- **A repeated tick keeps its first date** — when it happened is the fact being
  recorded (docs/59 §2).
- **A repeated measurement takes the new number.** Somebody re-read the scales;
  refusing the correction would leave a wrong weight on the record for ever.

A number sent for a column with no unit is dropped, or a stray value lands
somewhere with no unit and the before-and-after starts counting things that are
not measurements.

## 3. Before and after, derived

`change` on each row gives `{ first, latest, delta }` per unit — 82.4 → 76.5,
−5.9 kg — computed from the marks in **column order**, which on a staged sheet
is chronological because that is how the sheet is laid out.

Derived rather than stored, so it cannot drift from the readings it summarises.
The same reasoning as docs/61 §2: a column to keep a number in is a place for
one to go stale.

## 4. The course and the pack

Seeded beside the sheet, because the sheet exists to follow _them_ up.

**The course** is a spine — six weeks, a title each — so the learning module has
something real to attach to and a coach has somewhere to put the material. The
words inside are the business's, and an empty lesson is honest about that.

**The pack carries no price.** What 6WNY costs is the business's number, the
same rule as the ladder's thresholds (docs/62 §2) and "5+3" (docs/58 §3.2). It
seeds `status: 'draft'` at zero, and both the catalogue and the cart already
require `status: 'active'` — so it cannot be listed or sold until somebody
prices it. **A pack that could be bought for nothing is worse than one that
cannot be bought yet.**

### 4.1 A test that would have passed for the wrong reason

The first version proved "cannot be sold" by adding the draft pack to a cart and
expecting 404. It returned **403** — this suite's seller has no commerce
entitlement, so the cart refuses at an earlier gate and the draft status does
none of the work.

Removed rather than loosened to accept either code. The cart's own
`status: 'active'` filter is covered where commerce is actually entitled; here
the assertions are the catalogue absence and the row itself.

## 5. Still missing: before/after photos

The sheet says **"ถ่ายรูป Before"** and **"ถ่ายรูป Before After"**. That step
exists as a tick and cannot be more than a tick, because **this system has no
file storage at all** — no R2, no S3, no upload path anywhere in `apps/api`.

Not deferred for effort. Object storage is a real dependency with a bucket, a
credential, a signing scheme and a retention decision behind it, and photographs
of customers' bodies are about the most sensitive thing this product could hold.
Building half of that to make a checkbox look complete would be the wrong trade.

The smallest honest next step is the storage itself — a bucket, signed upload
URLs, and a deletion path — and it should be its own piece of work with its own
privacy decision, not a corner of a programme sprint.
