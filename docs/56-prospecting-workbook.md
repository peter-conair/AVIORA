# 56 · The prospecting workbook

## 1. Where this came from, and what docs/33 got wrong

Spec §41 lists "Prospecting" as a Business OS capability. docs/33 declined it
with one line — _"its listed capabilities are CRM + commerce + analytics,
already present"_ — and that was too quick.

The business runs on a paper workbook, and the sheets are specific: two name
lists with **different scoring columns**, a Memory Jogger that exists purely to
get names out of somebody's head, a customer index, a product-interest grid,
monthly goals and a weekly review. A CRM with a lead table and a pipeline does
not do any of that. It stores the _result_ of prospecting and has nothing to say
about the act of it.

This sprint builds the first three sheets. §8 lists what is still paper.

## 2. Two lists, different columns

|           | Sponsor name list | Customer name list |
| --------- | ----------------- | ------------------ |
| Active    | ✓                 |                    |
| Friendly  | ✓                 |                    |
| Money     | ✓                 | ✓                  |
| Authority |                   | ✓                  |
| Relation  | ✓                 | ✓                  |
| Age       | ✓                 |                    |
| Max score | 25                | 15                 |

Taken from the sheet, not invented.

**`money` and `relation` are one rating, shown on both lists.** A person has one
relationship with you and one financial position; storing them twice invites two
contradictory numbers for the same fact. Rating somebody as a customer therefore
moves their sponsor total too, and a test pins that — recomputing only the list
being edited would leave the other quietly stale.

**Each list totals its own columns only.** Adding every rating together would
make the two totals incomparable: a name rated on five criteria would always
outrank one rated on three, whatever the ratings said.

**A person can be on both lists**, which is why these are two booleans rather
than one "kind". One `kind` would force a second row for the same person, and
the duplicate check from docs/55 would — correctly — refuse to create it.

## 3. Twenty rows

The sheet has twenty. Filling it is the exercise, so the API returns `target`,
`filled` and `remaining` rather than a list the salesperson has to count, and
the screen leads with the gap.

Unrated names are reported separately (`unrated`). They look like progress and
are not, which is exactly the thing a coach should be pushing on — and a screen
that shows them as `0 / 25` alongside genuinely low scores cannot tell the two
apart. The list shows a dash instead.

## 4. The Memory Jogger

"Write down twenty names" produces four and a blank stare. The sheet solves it
by not asking for names at all — it asks who cuts your hair, who sold you your
car, who you sat next to in school — and the names arrive as a side effect. The
catalogue is `packages/shared/src/prospecting/memory-jogger.ts`, six categories
and fifty-odd prompts, in Thai and English.

Two things the paper cannot do:

- Each prompt shows **how many names it has produced**, not a tick. Six names
  from one prompt reads differently from one.
- Every name keeps the prompt that produced it, so §6's report can say which
  prompts work for this person.

A name added here goes onto **both** lists. Deciding which list somebody belongs
on is the next exercise, and forcing that choice at the moment of remembering is
what stops people writing the name down at all.

An unknown prompt key is refused at the edge rather than stored loose, or it
would appear in the report as a category nobody can find on the sheet.

## 5. The screens

`/prospecting`, tabs in the order the work happens: **Memory Jogger → sponsor
list → customer list → report.** The jogger is first because a blank name list
is the problem it exists to solve.

The paper grid is wide, and a 360 px phone cannot honestly show twenty rows by
five columns. So the grid becomes one card per person with the criteria as a row
of small selects — the same columns, stacked. Nothing is lost: on paper you can
see every rating for one name at once, and that is what this preserves.

### 5.1 The API test could not have caught this

The name-list endpoint returned each criterion's `label` as `{ en, th }` — the
whole shared constant, handed to the screen. The component rendered the object,
React threw, and the page went blank.

Every integration test passed throughout, because they read `criteria[].key` and
never touched a label. It was found by opening the page.

Fixed by localising server-side, the way the Memory Jogger already did, and
`apps/web/e2e/prospecting.spec.ts` now walks the workbook in a browser so a
screen that renders nothing cannot pass again.

## 6. The report

Three questions, not a dashboard:

1. **Are the sheets full?** filled / 20 per list, and the gap.
2. **Who do I call next?** top five per list by that list's own score.
3. **Where are my names coming from?** names produced per jogger category.

The third one is the only thing here the paper cannot do, and it lists **every**
prompt including the ones that produced nothing. A report showing only what
worked cannot tell you what you have not tried yet, so the zeroes are the point.

## 7. Scope

A name list is one salesperson's own book — the endpoints run through
`CrmScopeService` exactly like the rest of the CRM, so a leader sees their org's
and a member sees only their own. A test pins that somebody else's twenty names
never appear on your sheet.

## 8. Still on paper

Named here so the next sprint has a list, and so nobody mistakes this for the
whole workbook:

- **Customer index** — ABO#, expiry, ID#, DOB, and the twelve-month SOP grid.
- **Product-interest grid** — customers × product columns. The products are
  already `offerings`; the grid is not built.
- **Setting goals** — monthly PPV target, new-GT count, the 5+3 development
  target. The existing `goals` module is personal/health goals, which is a
  different thing wearing the same word.
- **Weekly update** — progression, new prospects, continuing plan, Q&A.
- **Organisation chart** — already exists as `/teams`; the sheet is a print of
  the same thing.
