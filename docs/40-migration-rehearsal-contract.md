# 40 — Migration Rehearsal at Volume (Sprint 21)

> docs/33 §3: _"A large tenant can move to a dedicated database with zero data
> loss — routing seam, extract/verify tooling and runbook exist (docs/31–32).
> **Never run at volume.**"_ The tooling has only ever moved tenants with a few
> hundred rows, which is not the case anybody is afraid of.

## 1. What "at volume" is actually testing

Not correctness — docs/32's `verify` compares row counts and per-table
checksums, and that check does not get weaker with size. Volume tests three
different things, and each has a specific way of going wrong:

| Question                         | How it fails at size but not at ten rows                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **How long is the tenant down?** | The runbook makes the tenant read-only for the whole extract-restore. A minute is a maintenance note; forty is an incident.               |
| **Does the extract file scale?** | Rows are emitted as `jsonb_populate_recordset` in chunks of 500. A million rows is either a big file or a `psql` that runs out of memory. |
| **Does anything time out?**      | Prisma, `psql` and the connection pool all have limits nobody has met yet.                                                                |

So the rehearsal reports **numbers**, not a pass/fail: file size, extract
seconds, restore seconds, verify seconds, and the read-only window they add up
to. Those are what a person needs to decide whether to schedule a migration at
2am or at all.

## 2. It never touches the real database

`scripts/migration-rehearsal.sh` works entirely on scratch databases:

```
dev database ──dump/restore──▶ aviora_migsrc_<stamp>   (inflated to volume here)
                                        │ extract
                                        ▼
                               aviora_migdst_<stamp>   (schema only, then restored into)
```

The tenant being inflated to hundreds of thousands of rows is inflated in a
**copy**. Nothing is written to the database anybody is using, which is what
makes it safe to run this on a laptop or beside production.

Like the restore drill (docs/39), it drops nothing and prints the cleanup
commands instead.

## 3. What it inflates, and why those tables

Volume is added to the tables a real large tenant is actually large in, in
their dependency order:

- `members` — the row every other tenant table points at
- `orders` and `order_items` — the widest rows, and the ones with money in them
- `domain_events` — the table that grows fastest and is never pruned
- `notifications` — one per member per event, the classic runaway

Inflating only `domain_events` would make a fast, misleading rehearsal: it is
one flat table with no dependents. The point is to measure an extract that has
to order tables by foreign key and carry a self-referencing tree.

## 4. What it does not claim

- **It is not the real migration.** It rehearses extract → restore → verify.
  Pointing the tenant at its new database (docs/32 §4.7) and the rollback path
  are operator steps against the live routing table, and a rehearsal that
  practised them would be practising on production.
- **The numbers are this machine's numbers.** A laptop and a managed Postgres
  differ; what transfers is the shape — where the time goes, and whether
  anything falls over.

## 5. What the first run measured (2026-08-21)

One tenant, on a laptop, against Postgres 17 in Docker. Two runs, so the shape
of the scaling is visible rather than a single point:

| Rows moved | Extract file | Plan | Extract | Restore | Verify | **Read-only window** |
| ---------- | ------------ | ---- | ------- | ------- | ------ | -------------------- |
| 34,107     | 12.5 MB      | 0.7s | 1.0s    | 0.4s    | 0.8s   | **2.3s**             |
| 340,107    | 124.0 MB     | 0.6s | 3.9s    | 3.9s    | 2.3s   | **10.3s**            |

87 of 87 tenant tables matched on row count and checksum both times.

Ten times the rows cost about four and a half times the window, so the work is
not linear in the bad direction — but the honest reading is that nobody should
extrapolate far from two points on one machine. What these numbers support is a
narrower claim: **a tenant of a few hundred thousand rows moves inside a
maintenance window measured in seconds, not minutes.**

### The number to watch is the file, not the clock

124 MB for 340k rows is roughly 380 bytes per row, and the extract is **one
transaction in one file** that `psql -f` reads. A tenant with 5 million rows
would produce something near 1.8 GB. Nothing here failed, and nothing suggests
it would at 2 GB, but that is the dimension that turns first — and it turns into
a memory problem, not a slow one. A tenant that large should have its extract
run and its file size measured before the read-only window is announced, which
is what §3's `plan` step is for.

### What the rehearsal does not include in that window

The read-only window above covers extract → restore → verify. It does **not**
include docs/32 §4.4 — copying the platform-global `users` rows the tenant's
members need — which is still manual, and still the step most likely to be
forgotten. The rehearsal makes that visible by creating a user per member: they
are inflated alongside, and then they do not appear in the extract, because
users are not the tenant's to move.

## 6. Running it

```bash
pnpm db:migration-rehearsal
MEMBERS=50000 EVENTS=250000 pnpm db:migration-rehearsal
```
