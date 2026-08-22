# 59 · The tracking sheets — one engine, three sheets

## 1. Three sheets, one thing

The Follow Up Sheet (44 columns), the Diamond Check List (14) and the 6WNY
protocol (34, in five stages) look like three features. They are one:

> **a template** — an ordered list of steps, optionally grouped into stages —
> **applied to people**, producing **ticks with a date on them**.

Building them as three grids would have been three times the code and three
places to fix anything. Worse, it would have been wrong: the columns say
`6WNY`, `eSpring`, `GG Pack`, `UNIT12`. Those are **this business's products**,
and on a multi-tenant system another tenant sells something else.

So the columns are **tenant rows**, seeded from
`packages/shared/src/prospecting/tracker-templates.ts` and editable afterwards.
Nothing in the engine or the screen knows any column's name. A tenant that
writes its own sheet gets the same grid, the same progress bar and the same
report for free.

## 2. The tables

| Table               | What it holds                                    |
| ------------------- | ------------------------------------------------ |
| `tracker_templates` | a sheet: code, name, and what its rows are about |
| `tracker_steps`     | a column: label, optional stage band, order      |
| `tracker_entries`   | a row: this sheet, applied to this person        |
| `tracker_marks`     | a tick: when, and by whom                        |

`UNIQUE (tenant_id, template_id, subject_type, subject_id)` — one row per
person per sheet. Two would let somebody be half-ticked in two places and
neither would be the truth.

`UNIQUE (entry_id, step_id)` — ticking twice is the same tick. The upsert keeps
the **first** date, because when it happened is the fact being recorded; letting
a second tick reset it would make a stalled row look fresh.

## 3. Seeding, and not arguing with the user

Sheets appear on first read, the same way the CRM pipeline seeds its stages —
a tenant that has never opened an editor still gets working sheets.

It seeds **only into a tenant that has none at all**. A tenant that deleted the
Diamond sheet would otherwise find it back on the next page load, which is the
system arguing with its user about a decision the user already made.

## 4. Why a tick is a row and not a boolean column

A `boolean` would be smaller and would answer "is this done". It cannot answer
**"has this line moved in two months"**, and that is the question the Diamond
sheet exists to ask.

So every tick carries `marked_at` and `marked_by_member_id`, and the entry
denormalises `last_marked_at` so "who has stalled" is one indexed query rather
than a scan of every tick in the tenant.

Marks are **not** in the audit log, and `audit-coverage.spec.ts` records why: a
busy line produces hundreds of ticks a week, and auditing each would bury the
rows that log exists for. Nothing is lost — `tracker_marks` already stores when
and who, which is strictly more than an audit row would say. **Adding a person
to a sheet is audited**, because that is a decision rather than routine work.

## 5. The report the paper cannot produce

`GET /tracker/stalled?days=14` — rows that are not finished and have not moved.

Two details that decide whether it is useful:

- **Started and never touched counts as stalled.** A plain
  `last_marked_at < cutoff` filter misses exactly those rows, because the column
  is still null — and somebody written down and never worked is the worst case,
  not an absent one.
- **`days=0` means "everything still open"**, and is not treated as "no value
  given". The first version rewrote `0` to the default `14` and silently
  answered a different question than the one asked. `Number('')` is `0`, so the
  empty case has to be checked _before_ parsing rather than after.

## 6. The screen

One component for all three sheets, which is the test of whether the
abstraction is real — it never names a column, and it picks the list to add
people from by reading the sheet's own `subjectType`.

Forty-four columns cannot honestly be shown at 360 px, so each person is a card
whose steps are chips grouped under the stage bands the paper draws. What is
kept from paper: one person's whole row visible at once. What is added: the
date, and therefore the stalled list.

## 7. Scope

`tracker.view` is `DESCENDANT_TEAMS` for a leader — looking down a line is the
entire point of the Diamond sheet. `tracker.manage` is `SELF` for everyone,
including leaders: **a tick is a claim that work was done**, and the person who
did it is the one who says so.

## 8. A build step that hid a change

The role grants above are in `packages/db/src/system-roles.ts`, and the API
consumes `@aviora/db` as a **built** package. Adding the permissions to the
source and re-running the tests produced `403` everywhere, with the grants
visibly present in the file.

`pnpm --filter @aviora/db build` was the missing step. Worth writing down
because the symptom — a permission that exists in the code and not in the
database — looks exactly like a seeding bug.
