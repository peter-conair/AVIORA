# 58 · The monthly goal sheet

## 1. The sheet

`SETTING GOALS` has two halves that are different in kind, and the screen keeps
them visually different for that reason.

**Narrative** — short term (this month), medium (one financial year), long (five
years), life goal. Free text. Stored, never scored, nothing pretends to measure
it.

**Numeric** — `ยอด` volume, `คน` new partners, `พัฒนา 5+3`. This is the half a
system can actually help with, and the only reason to stop using paper.

## 2. Why the goal comes before the name list

The workbook's own order, and `/prospecting` now opens on it: a name list with
no number attached to it is an address book. `30000 PPV` is what turns "write
twenty names" into "write twenty names _because_".

## 3. Where the numbers come from

| Target       | Actual                             | Source       |
| ------------ | ---------------------------------- | ------------ |
| Volume       | `personal_volume`, calendar month  | **computed** |
| New partners | `direct_referrals`, calendar month | **computed** |
| Develop 5+3  | typed by the member                | **manual**   |

### 3.1 One definition of the month

Progress runs through `computeMetrics` — the same definitions that drive rank
qualification and compensation — not a second count written for this screen.

If the goal counted volume its own way, a member could be told they did 28,000
here while their rank qualification said 31,000 for the same month. Both would
be defensible, one would be wrong, and nobody could say which. The month is a
fact and it gets one definition.

The metric keys are built with `requirementKey()` rather than written as
literals, because a hardcoded key shape breaks silently the day the default
graph is renamed — and it breaks by reading zero, which looks exactly like a
member who did nothing.

### 3.2 Computed and typed must not look alike

Every number carries a `source`, and the screen prints it: _"ระบบนับให้จากยอดที่ชำระ
แล้ว"_ against the two it measures, _"ช่องนี้คุณกรอกเอง ระบบไม่ได้วัดให้"_ against 5+3.

`5+3` is a coaching convention whose exact definition belongs to the business,
not to me. A number I invented for it would render identically to one that was
measured, and that is how a dashboard starts lying. Where the system does not
know, it asks and says so.

## 4. One sheet per member per month

`UNIQUE (tenant_id, member_id, month)`, and the endpoint is a `PUT` upsert.
Two rows would leave two answers to "what was the goal", and the weekly update
(docs/57 §4) would report against whichever it read first.

`month` is a `date`, not a timestamp. Which month a sheet is for is a calendar
fact; storing it as an instant makes it depend on the reader's zone, and August
becomes July for anybody east of the server.

Progress is anchored to **the month being asked about**, not to now — a coach
reviewing March in April must see March, or the sheet reports April's empty
month as a failed target.

## 5. Scope

A member reads their own sheet. A leader may read a member inside their scope,
because holding the goal at the weekly meeting is the entire point of it. Anyone
else gets a 403, and a test pins it.

## 6. A test that proved nothing

The first version of the "agrees with the rank engine" test compared the sheet
against `POST /ranks/preview` — an endpoint that does not exist. The comparison
sat inside `if (preview.status === 200)`, so it never ran, and the test passed
by doing nothing.

Replaced with an independent check: buy something of a known price through the
real checkout, then require the sheet to move by exactly that amount — plus an
assertion that the price was not zero, since a free offering would have made the
whole thing pass vacuously again.
