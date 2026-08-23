# 61 · The weekly review

## 1. What the sheet is

Four boxes, filled in once a week against the month's goal:

| Box                 | The question on the paper                                      |
| ------------------- | -------------------------------------------------------------- |
| Progression Update  | จากแผนต้นเดือนแต่ละเรื่องทำถึงไหนแล้ว — ถึง / ไม่ถึง เพราะอะไร |
| New Prospect Update | มีใครน่าสนใจบ้าง ทำอะไรกับเค้าไปบ้าง มีแผนจะทำอะไร             |
| Continuous Plan     | ยอดส่วนที่เหลือจะมายังไง / ปรับเป้าหมาย                        |
| Q & A               | คำถามเพิ่มเติม                                                 |

## 2. The table stores words and nothing else

`weekly_updates` has four text columns and no numbers at all. Every figure on
the screen is computed at read time — from the month's goal, the paid orders,
the leads created this week, the ticks made this week and the checklist logs.

This is the whole argument for building it. A member retyping last week's
figure into this week's box is how a paper system quietly loses touch with what
happened, and there is nothing a computer does better here than simply look. A
column to store a number in would be a place for one to go stale, so there
isn't one — and a test asserts the row has no such column.

## 3. What is computed

- **Volume**: target, actual, and what is still to find. Read through the goal
  service, so it is the same number the goal sheet and the rank engine quote
  for that month (docs/58 §3.1). A test pins the two together.
- **New partners**: target and actual, same source.
- **Days left in the month**, because "behind" means nothing without it —
  _behind with three days left_ and _behind with three weeks left_ are different
  sentences, and the Progression box is asking the member to write one of them.
- **Pace**: the share of the month gone against the share of the target done.
- **This week**: names added, steps ticked, checklist boxes, and how many rows
  on the tracking sheets have never been started at all.

### 3.1 No target means no judgement

`onPace` is `null`, not `false`, when no target was set — and the screen says
_"เดือนนี้ยังไม่ได้ตั้งเป้า"_ rather than showing a red bar.

A member who has not set a target has not failed. Reporting them as behind would
be the screen inventing a judgement out of missing data, which is the same
failure as inventing a number.

## 4. Which month a week belongs to

The month containing the week's **Sunday**. A week straddling the turn of the
month reports against one goal, not against whichever the reader happened to
have open, and a test pins `2026-03-04 → week 2026-03-01 → month 2026-03-01`.

The pace test uses a month that has entirely finished, so `elapsedShare` is 1
whatever day it runs. Asserting against the current month would have passed all
month and flipped on the 1st, when almost none of it has elapsed — the same
class of date-dependent flake as the timezone bug in docs/36.

## 5. A bug the API tests could not have found

The browser test saved a note, reloaded, and found the box empty. The database
showed the row written with `progression_note = NULL`.

The cause was in the screen: `load()` reseeds the boxes from the server, and a
refresh landing while somebody is **mid-sentence** overwrote what they had
typed. The save that followed then posted the empty value over their own words.

Every API test passed throughout — the API was told to store nothing and did
exactly that, correctly.

Fixed with a `dirty` flag: a load never overwrites text the person is still
typing, and it clears on save or when the week changes. The goal sheet seeds its
draft the same way and had the same hole, so it got the same guard.

### 5.1 The first fix passed alone and failed in the suite

`dirty` as state was not enough. `load()` closes over it at the moment the
function is created, so a request that resolved **after** the person started
typing still read `false` and reseeded the boxes anyway.

That is why it passed when run alone — the response landed before the typing —
and failed in a full run, where everything is slower. The guard now reads a ref,
which has no stale copy. A concurrency bug whose only symptom was the order the
tests ran in is exactly the kind that reaches production as "it sometimes loses
what I wrote".

## 6. Scope

A member writes their own. A leader in scope may **read** it — holding the sheet
at the weekly meeting is the entire point — and the boxes render disabled for
them, because the answers are the member's to give.

Not audited: these are notes a member writes about their own week, in their own
words, already visible to their coach by design. An audit row would be a second
copy of prose the member owns, and there are no stored numbers to falsify.
