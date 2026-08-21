# 39 — Restore Drill Contract (Sprint 20)

> docs/18 has said, since it was written, that _"a backup that has never been
> restored is not a backup"_ and that restore is tested quarterly. Nothing has
> ever tested it. This sprint makes the promise executable and runs it once.

## 1. The failure a restore drill is actually looking for

Not "did the file come back". `pg_restore` reporting success is the easy half.
The question this platform has to ask is narrower and much worse if the answer
is wrong:

**Does the restored database still refuse a tenant access to another tenant's
rows?**

Row-level security lives in the schema, but the things that make it _bite_ do
not all travel in a plain dump:

| Thing                       | In `pg_dump`? | If it is missing after a restore            |
| --------------------------- | ------------- | ------------------------------------------- |
| `ENABLE ROW LEVEL SECURITY` | yes           | —                                           |
| `FORCE ROW LEVEL SECURITY`  | yes           | the owner bypasses every policy             |
| The policies themselves     | yes           | every tenant sees every row                 |
| The `aviora_app` **role**   | **no**        | restore fails, or grants land nowhere       |
| That role's `GRANT`s        | yes¹          | the app cannot read, or can read too much   |
| `search_path`, extensions   | yes           | —                                           |
| The migration ledger        | yes           | the next deploy replays or skips migrations |

¹ Grants are dumped, but they reference a role that a fresh cluster does not
have. Roles are cluster-scope and come from `pg_dumpall --roles-only`, which is
a **second file** — and a backup strategy that takes only the first one restores
a database whose security model is missing its subject.

That is the specific thing this drill exists to catch, and it is exactly the
kind of gap that stays invisible until the day it matters.

## 2. The drill never destroys anything

`scripts/restore-drill.sh` dumps, creates a **scratch** database, restores into
it, verifies, reports — and stops. It does not drop the scratch database, and it
cannot drop anything else, because it contains no `DROP DATABASE` at all.

This is deliberate. A restore drill is a tool that runs beside production
holding a connection with rights to everything; a drill that also knows how to
drop databases is one typo away from being the incident it was written to
prevent. It prints the `dropdb` command for a person to run when they have
looked at the result.

## 3. What it verifies

1. **Every table arrived**, and the count matches the source.
2. **Row counts match** for every table that has rows — not a sample. A dump
   that quietly lost a table's contents must not pass.
3. **RLS is enabled AND forced** on every table that had it. Forced matters
   most: without it the owner role reads through every policy.
4. **Every policy came back**, by name and by expression.
5. **The app role's grants came back**, and the role exists.
6. **A live isolation probe**: set `app.tenant_id` to one tenant, count rows
   another tenant owns, and require zero. This is the only check that tests the
   restored database's _behaviour_ rather than its catalogue.
7. **The migration ledger matches**, so the next deploy does not replay.

Anything that fails is reported with what it found; the script exits non-zero
so a scheduled run cannot fail silently into a green tick.

## 4. What it does not claim

- **It is not a production restore rehearsal.** It runs against whatever
  database it is pointed at. Pointed at a staging copy of production it measures
  something real; pointed at a developer's database it proves the _procedure_
  works, not that production's backups do.
- **It does not measure downtime.** Time-to-restore at production volume is a
  different exercise and needs production volume.
- **It does not test point-in-time recovery.** PITR is the provider's feature
  and rehearsing it means driving the provider's console, not `pg_dump`.

## 5. What the first run found (2026-08-21)

Run against the development database: **pass**. 99 tables, 89 with RLS enabled,
89 policies, 390 grants to `aviora_app`, 24 migrations, every populated table
matching row for row, and a tenant unable to read another tenant's members in
the restored copy.

Two things the run made visible that a green tick alone would not have:

- **89 tables have RLS enabled; 84 have it forced.** The five are the knowledge
  join tables — `article_topics`, `article_ingredients`, `health_goal_topics`,
  `topic_ingredients`, `product_ingredients` — which carry no `tenant_id` and
  hold a deliberate `join_open` policy: they connect rows whose own policies
  already gate them. That is by design and stated in the migration that created
  it. It is recorded here so the gap between 89 and 84 reads as a decision when
  somebody meets it later, rather than as drift.
- **The roles file is a second file.** `pg_dump` produced 8.7 MB and no roles;
  `pg_dumpall --roles-only` produced the two this platform depends on. A backup
  routine that takes only the first would restore a database whose grants name a
  role that does not exist.

## 6. Running it

```bash
pnpm db:restore-drill              # against AVIORA_DATABASE_URL
SOURCE_URL=postgres://… pnpm db:restore-drill
```

It is deliberately **not** in CI. CI's database is whatever the test suite just
built, so a drill there would prove the script runs — which the script proves by
running anywhere. The claim worth making is about the backups that actually
exist, so this belongs on a schedule against a staging restore of production,
which is the quarterly exercise docs/18 already asks for.
