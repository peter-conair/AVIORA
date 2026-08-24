# 57 · The workbook, end to end — what gets built and in what order

## 1. The ordering principle

The sheets are not a feature list. They are one loop a member walks, over and
over, and the order they are built in should be the order a member meets them —
because a sheet built out of order has nothing to read from and nothing to feed.

```
        ┌─────────────── SET A GOAL ───────────────┐          ← the start
        │            month: volume · people        │
        ↓                                          │
   MEMORY JOGGER  →  NAME LISTS  →  INVITE  →  FOLLOW UP
        (done)         (done)                      │
        ↓                                          │
   CUSTOMER INDEX ← repeat orders ← BUY ───────────┘
        │
        ↓
   WEEKLY UPDATE  →  did the goal move?  →  next week   ← the growth engine
        │
        ↓
   ORGANIZATION CHART   (already `/teams`)
```

Two consequences drive everything below:

- **The goal comes first**, before the name list. A name list with no number
  attached to it is an address book. The sheet's `30000 PPV / NEW GT / 5+3` is
  what turns "write twenty names" into "write twenty names _because_".
- **The weekly update is what makes it grow.** Goals set once a month and read
  once a month are decoration. The loop only compounds if something asks, every
  week, whether the number moved and what changed.

## 2. Phases

| Phase | Sheet                             | Status             | Why here                                    |
| ----- | --------------------------------- | ------------------ | ------------------------------------------- |
| 0     | Memory Jogger, name lists, report | **done** (docs/56) | Where the user pointed first                |
| **1** | **Setting Goals**                 | **this sprint**    | Nothing above it has a number to aim at     |
| 2     | Weekly Update                     | next               | The engine; needs a goal to report against  |
| 3     | Customer Index + SOP grid         | after              | Needs customers, which phase 1–2 produce    |
| 4     | Product-interest grid             | after 3            | A column per offering on the index          |
| 5     | Organisation chart                | mostly done        | `/teams` exists; the sheet is a print of it |

## 3. Phase 1 — Setting Goals (this sprint, docs/58)

The sheet has two halves and they are different in kind:

**The narrative half** — short term (this month), medium (one financial year),
long (five years), life goal. Free text, because that is what it is. Stored, not
scored.

**The numeric half** — `ยอด` volume, `คน` new partners, `พัฒนา` 5+3. These are the
part a system can actually help with, and the whole reason to stop using paper.

### 3.1 The rule that makes it worth building

**Progress is computed from the same metric definitions that drive ranks and
compensation** — `computeMetrics` with a `calendar_month` window, not a second
count written for this screen.

If the goals screen counted volume its own way, a member's goal would say they
did 28,000 while their rank qualification said 31,000 for the same month, and
both would be defensible. One of the two would be wrong and nobody could say
which. The month is a fact; it gets one definition.

### 3.2 What is computed and what is typed

| Target                | Actual comes from                                    | Honest?                     |
| --------------------- | ---------------------------------------------------- | --------------------------- |
| Volume (PPV)          | `personal_volume`, calendar month — paid orders only | computed                    |
| New partners (NEW GT) | `direct_referrals`, calendar month                   | computed                    |
| Develop 5+3           | typed by the member                                  | **manual, and labelled so** |

The third one is manual on purpose. "5+3" is a coaching convention whose exact
definition belongs to the business, not to me, and a number I invented would
look identical on screen to one that was measured. Where the system does not
know, it asks — and says which is which.

## 4. Phase 2 — Weekly Update (next)

The four boxes on the sheet, against the month's goal:

- **Progression** — how far each thing has got, and if not, why. The _numbers_
  here are computed from the same metrics; the _why_ is typed.
- **New prospects** — who turned up this week, which the name lists already know.
- **Continuing plan** — what to do with the remainder, given how many days are left.
- **Q&A** — for the coach.

The one thing to get right: **the week's progression must be derived, not
retyped.** A member copying last week's number into this week's box is how a
paper system loses touch with reality, and the reason to build it at all is that
a computer can just look.

## 5. Phase 3–4 — Customer Index and the product grid

Per customer: ABO#, expiry, ID#, DOB, contact, notes, and the twelve-month SOP
grid — the repeat-order pattern that says who has stopped buying.

Two decisions to make when we get there, recorded now so they are not made by
accident:

- **The month grid should be read from real orders where they exist**, and
  hand-tickable where they do not, because a lot of this business is transacted
  outside the system. Same rule as §3.2: computed and typed must look different.
- **The product columns are `offerings`**, which already exist. The grid is a
  view over them, not a new product list.

## 6. Phase 5 — Organisation chart

`/teams` already renders the org tree. What the sheet adds is a printable
snapshot for the weekly meeting, so this is a print view rather than a feature.

## 7. What this is not

It is not a plan to digitise paper. Every phase above has one thing on it that
paper cannot do — a count of which prompt produced names, a volume that agrees
with the compensation engine, a customer who quietly stopped ordering in month
seven. If a phase turns out to have none, it should stay paper.

## 8. The four tracking sheets — and the one thing they actually are

Four more sheets arrived after this roadmap was first written, and they change
the plan for the better:

- **DIAMOND CHECK LIST** — people grouped by LINE 1–6, columns of milestones
  (`3 Packs`, `ใช้สินค้า`, `15 Packs`, `เข้า CENTER ทุกครั้ง`, `เป็น GT`, `ทำ 15+`,
  `เป็น 12%`, `UNIT12`, `Diamond Club`, `Turn Pro`, `Turn Pro+`).
- **FOLLOW UP SHEET** — people × ~40 milestone columns, with a `GT Qualification`
  band across part of it.
- **FOLLOW UP 6WNY** — people × checkpoints, grouped into stages: before the
  course, day 4, day 7, day 14, week 3 onward.
- **DAILY CHECK LIST** — 7 days × 5 weeks of eight habits, plus a weekly column.

### 8.1 Three of them are the same thing

Diamond, Follow Up and 6WNY are one primitive wearing three sets of column
headings:

> **a template** (an ordered list of steps, optionally grouped into stages)
> **applied to people**, producing **ticks with a date on them**.

Building three separate grids would be a mistake, and an expensive one. The
columns are business- and product-specific — `6WNY`, `eSpring`, `GG Pack`,
`UNIT12` — so on a multi-tenant system they cannot be hardcoded at all: another
tenant selling something else needs its own columns, not ours.

So the build is **one tracker engine plus seeded templates**:

| Piece               | What it is                                      |
| ------------------- | ----------------------------------------------- |
| `tracker_templates` | name, scope (person / downline), ordered stages |
| `tracker_steps`     | label, stage, order — the columns               |
| `tracker_entries`   | template × subject (a lead, member or customer) |
| `tracker_marks`     | step × entry × when × who — the ticks           |

The three sheets then ship as **seed data**, editable per tenant. A tenant that
sells something else writes its own columns and gets the same grid, the same
progress bar and the same report for free.

What this buys that paper cannot: **who has stalled**. A tick with a date on it
answers "this line has done `3 Packs` but nobody has reached `เป็น GT` in two
months", which is the question the whole Diamond sheet exists to ask and which
counting boxes by eye cannot answer.

### 8.2 The daily checklist is a different primitive — and already exists

`DAILY CHECK LIST` is eight habits repeated daily with a weekly review column.
AVIORA already has a **habits module** with idempotent daily logs and a 30-day
summary, built in Sprint 6. Rebuilding it as a grid would be duplicating a
tracked thing, which docs/24 already warns against.

So this sheet becomes: **seed the eight habits + the weekly checklist as habit
definitions**, and add the week-grid _view_ the sheet uses. The engine is done;
what is missing is the layout and the seed.

### 8.3 Revised phase order

| Phase | Sheet                             | Status                                                                   |
| ----- | --------------------------------- | ------------------------------------------------------------------------ |
| 0     | Memory Jogger, name lists, report | **done** (docs/56)                                                       |
| 1     | Setting Goals                     | **done** (docs/58)                                                       |
| 2     | Tracker engine + Follow Up Sheet  | **done** (docs/59)                                                       |
| 3     | Diamond Check List                | **done** — a seeded template on the same engine                          |
| 4     | 6WNY follow-up                    | **done** (docs/59, docs/64) — staged template + measurements             |
| 5     | Daily checklist                   | **done** (docs/60)                                                       |
| 6     | Weekly Update                     | **done** (docs/61)                                                       |
| 7     | Customer Index + SOP grid         | **done** (docs/66), screen in Sprint 48                                  |
| 8     | Organisation chart print          | **not built** — `/teams` renders the tree; the print view does not exist |

Added along the way, outside the original eight:

|                               |                    |                                                |
| ----------------------------- | ------------------ | ---------------------------------------------- |
| Starting the business         | **done** (docs/63) | the path a new member actually lands on        |
| The 6/9/12/15/18/21% ladder   | **done** (docs/62) | seeded as drafts; thresholds are the tenant's  |
| Before/after photos + consent | **done** (docs/65) | needs a durable storage adapter for production |
| The learning path             | **done** (docs/67) | what to know and what to do, at each stage     |

## 9. What is actually left

1. **The product-interest grid.** The second CUSTOMER NAME LIST sheet — customers
   down the side, product columns across (`Breakfast set`, `eSpring`,
   `Atmosphere`, `Spa`, `6WNY/Detox`). Never built. It is a tracker template
   whose steps are the tenant's own offerings rather than fixed text, which is
   the one thing the engine cannot seed today.
2. **The organisation chart print view.** `/teams` renders the tree; what the
   sheet adds is a printable snapshot for the weekly meeting.
3. **A durable storage adapter** (R2 or S3). Until one exists the API refuses to
   start in production with photos enabled, which is the intended state rather
   than an oversight (docs/65 §4.1).
4. **Two decisions that are the business's, not mine** (docs/65 §5): how long a
   progress photograph should live after a programme ends, and how a customer
   asks for a copy of their own. The two answers travel together.

Phase 2 moved ahead of the weekly update deliberately: the weekly update reports
on _things being tracked_, and until the tracker exists it has little to say.
