# 32 — Tenant Migration Runbook

> The operator procedure for moving one tenant's rows out of the shared
> database and onto its own (ADR-002's reserved path, docs/31 §2).
>
> **Status: unrehearsed at production volume.** Everything below has been
> written against a development database with development-sized data. No large
> tenant has been moved, there is no second database host, and there is no
> production traffic to bound downtime against. The roadmap exit criterion —
> _one large tenant migrated with zero data loss and bounded downtime_ — is
> **open**, and stays open until this document has been walked end to end on
> staging with real volume. Treat every timing here as unknown rather than
> small.

## 1. What moves, and what does not

| Thing                                                               | Moves? | Why                                                                   |
| ------------------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| Every table with a `tenant_id uuid` column                          | Yes    | That column is what makes a row the tenant's (ADR-002).               |
| The `tenants` row itself                                            | Yes    | Keyed by `id`, handled as a special case by the tool.                 |
| `users`                                                             | **No** | Platform-global. One person may belong to several tenants.            |
| `permissions` (the catalog), global knowledge (`tenant_id IS NULL`) | **No** | Platform reference data. Seed it into the destination instead.        |
| `tenant_databases`                                                  | **No** | The routing table itself. Copying it would misdirect the destination. |

The `users` line is the honest sharp edge. `members.user_id` references
`users.id`, so a destination database needs a `users` row for every member
being moved — but those accounts are not the tenant's to take, and some of them
belong to other tenants too. Until that is designed properly, this procedure
**copies** the relevant `users` rows into the destination and leaves the
originals in place, which means two databases hold a copy of the same account
and a password change in one does not reach the other. That is a real defect,
not a detail, and it is the first thing to resolve before this is used for
anything that matters.

## 2. Preconditions

- [ ] Destination database exists, is PostgreSQL 17, and is reachable from the API hosts.
- [ ] The **same migration set** has been applied to the destination (`pnpm --filter @aviora/db db:migrate`). The verify step compares checksums that depend on column order.
- [ ] The `aviora_app` role exists in the destination with the same grants (`pnpm --filter @aviora/db db:setup-app-role`).
- [ ] Platform reference data seeded into the destination (permission catalog, global knowledge).
- [ ] A backup of the **source** database taken and its restore tested — not just written.
- [ ] `AVIORA_TENANT_TARGET_DATABASE_URL` exported in the operator's shell, pointing at the destination as a **superuser** (the restore needs `session_replication_role`).
- [ ] A secret-manager entry holding the destination DSN, and the environment variable it lands in on the API hosts (e.g. `AVIORA_TENANT_DSN_ACME`). `tenant_databases.dsn_secret_ref` will hold `env:AVIORA_TENANT_DSN_ACME` — a **reference**, never the DSN.
- [ ] A maintenance window announced to the tenant. Writes will be refused for its duration.

## 3. Dry run (no downtime, do this days earlier)

```bash
# What would move, and how much of it
curl -s -X POST "$API/api/v1/platform/tenant-databases/$TENANT_ID/plan" \
  -H "authorization: Bearer $PLATFORM_TOKEN" | jq

# The same numbers from a shell, if the API is not convenient
pnpm --filter @aviora/db tenant:migrate plan --tenant "$TENANT_ID"
```

Read the `caveats` array in the response. It lists what the row counts do not
account for.

**Check between steps:** the row counts should be the same order of magnitude
as the tenant's dashboards suggest. A table with unexpectedly many rows (or
zero where there should be some) means the plan is measuring something other
than what you think it is — stop and find out which.

## 4. Cutover

### 4.1 Make the tenant read-only

```sql
-- As the OWNER role. The app role cannot write this table by design:
-- the sprint-15 migration REVOKEs INSERT, UPDATE and DELETE on it.
INSERT INTO tenant_databases (id, tenant_id, status, notes, created_at, updated_at)
VALUES (gen_random_uuid(), '<tenant-uuid>', 'migrating', 'cutover <date> by <operator>', now(), now())
ON CONFLICT (tenant_id) DO UPDATE SET status = 'migrating', updated_at = now();
```

**Check before continuing:** the API refuses writes for this tenant. The
refusal is immediate — the read-only check reads this table on every mutating
request rather than a cache, precisely so there is no window in which writes
are accepted and then discarded (docs/31 §2).

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/v1/goals" \
  -H "x-tenant-id: $TENANT_ID" -H "authorization: Bearer $MEMBER_TOKEN" -d '{}'
# expect: 503, with error.code = TENANT_READ_ONLY
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/v1/goals" \
  -H "x-tenant-id: $TENANT_ID" -H "authorization: Bearer $MEMBER_TOKEN"
# expect: 200 — reading is unaffected
```

Do not proceed until you have seen both. A migration that accepts writes it is
about to discard is a migration that loses data.

### 4.2 Let in-flight work finish

Background work does not go through the API edge, so the read-only guard does
not stop it. Before extracting:

- [ ] Stop the worker process (BullMQ consumers, the outbox relay) or confirm the outbox is drained for this tenant:
      `SELECT count(*) FROM domain_events WHERE tenant_id = '<tenant>' AND processed_at IS NULL;` → expect `0`.
- [ ] Confirm no webhook deliveries are pending:
      `SELECT count(*) FROM webhook_deliveries WHERE tenant_id = '<tenant>' AND status = 'pending';` → expect `0`.

**This is the step most likely to be got wrong.** The read-only guard is an
API-edge control and says so; it is not a database-level freeze.

### 4.3 Extract

```bash
pnpm --filter @aviora/db tenant:migrate extract \
  --tenant "$TENANT_ID" --out "tenant-$TENANT_ID.sql"
```

The file is one transaction, tables in foreign-key dependency order, rows in
`jsonb_populate_recordset` statements of 500. It suspends foreign-key triggers
for the restore (`session_replication_role = 'replica'`) because Prisma's
foreign keys are not deferrable and self-referencing tables cannot otherwise be
inserted in any single order.

**Check:** the row counts printed on stderr match §3's plan. If they do not,
something wrote after the tenant went read-only — go back to 4.2.

### 4.4 Copy the platform-global rows this tenant's members need

Until §1's `users` problem is designed away, this is manual and deliberate:

```sql
-- On the SOURCE, list them:
SELECT u.* FROM users u
JOIN members m ON m.user_id = u.id
WHERE m.tenant_id = '<tenant-uuid>';
```

Move them into the destination by whatever means your environment allows, and
**write down** that these accounts now exist in two places.

### 4.5 Restore

```bash
psql "$AVIORA_TENANT_TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -f "tenant-$TENANT_ID.sql"
```

`ON_ERROR_STOP=1` matters: without it psql carries on past a failed statement
and you get a partial tenant that verify will catch but the restore will not.

### 4.6 Verify

```bash
pnpm --filter @aviora/db tenant:migrate verify \
  --tenant "$TENANT_ID" --target "$AVIORA_TENANT_TARGET_DATABASE_URL"
```

Per table: row count on both sides and an order-independent md5 over every
row's JSON rendering. It exits non-zero if anything differs.

**Also check, because the tool does not:**

- [ ] Referential integrity, which the restore skipped:
      re-validate the foreign keys, or at minimum spot-check the joins the tenant's product depends on (`members → users`, `member_roles → roles`, `team_closure → teams`).
- [ ] `SELECT count(*) FROM members WHERE tenant_id = '<tenant>'` on the destination matches the tenant's own member list.
- [ ] Row-level security is enabled and forced on the destination (`apps/api/test/integration/schema-meta.spec.ts` asserts this shape — run it against the destination).

Do not proceed on a checksum mismatch. Investigate; the extract is repeatable
and costs nothing but time.

### 4.7 Point the tenant at its new database

```sql
UPDATE tenant_databases
   SET status = 'dedicated',
       dsn_secret_ref = 'env:AVIORA_TENANT_DSN_ACME',
       migrated_at = now(),
       updated_at = now()
 WHERE tenant_id = '<tenant-uuid>';
```

The environment variable must already be set on every API host. If it is not,
the resolver **fails closed**: requests for that tenant error rather than being
served silently from the shared database, which would hand people the rows
their tenant used to have.

**Check:** `GET /api/v1/platform/tenant-databases` shows the tenant as
`dedicated` with `dsnResolved: true`. Then exercise the tenant's product: a
read, a write, a login.

### 4.8 Leave the source rows alone

Do **not** delete the tenant's rows from the shared database in the same
window. Keep them until the tenant has run on the destination long enough that
you would be willing to bet on it — a week is a defensible minimum. They are
the rollback.

## 5. Rollback

At any point before 4.7, rollback is: set `status` back to `shared` and delete
what was restored into the destination. No source rows were touched.

After 4.7, and before the source rows are deleted:

```sql
UPDATE tenant_databases
   SET status = 'shared', dsn_secret_ref = NULL, migrated_at = NULL, updated_at = now()
 WHERE tenant_id = '<tenant-uuid>';
```

Within one resolver refresh the tenant is served from the shared database
again (routing uses a snapshot reloaded at boot and corrected as requests come
in; restart the API hosts if you want it immediate).
**Anything written to the destination after 4.7 is lost by this rollback.** If
the tenant has been live on the destination, rolling back means extracting from
the destination and restoring into the shared database — the same procedure,
reversed, with the same caveats. Decide which way you are going before you
start, not halfway through.

Once the source rows are deleted, there is no rollback. That is why 4.8 exists.

## 6. What this procedure does not handle

- **Zero downtime.** Writes are refused for the whole window. There is no
  logical-replication cutover here, and pretending otherwise would be worse
  than the honest maintenance window.
- **Bounded downtime.** The extract and restore are one statement per 500 rows
  through a single connection. Nobody has measured them at production volume.
- **The `users` split** (§1). Known, unsolved, first on the list.
- **Background workers.** They bypass the API edge; §4.2 stops them by hand.
- **Moving back at scale.** §5 works, but it is the same unrehearsed tooling.
- **Multiple tenants at once.** One at a time. The tooling takes one
  `--tenant`, and doing two concurrently doubles every unknown above.

## 7. Where the pieces live

| Piece                       | Path                                                 |
| --------------------------- | ---------------------------------------------------- |
| Routing seam                | `apps/api/src/common/db/tenant-database.resolver.ts` |
| Read-only edge              | `apps/api/src/common/db/tenant-database.guard.ts`    |
| Map + dry run               | `apps/api/src/modules/platform/tenant-database.*.ts` |
| Table catalogue / ordering  | `packages/db/src/tenant-tables.ts`                   |
| Extract / verify / plan CLI | `packages/db/scripts/tenant-migrate.ts`              |
| Contract                    | `docs/31-sso-tenant-database-contract.md` §2         |
