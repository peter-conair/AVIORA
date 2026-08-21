#!/usr/bin/env bash
#
# Restore drill (docs/39).
#
# Dumps a database, restores it into a fresh scratch database, and then asks the
# only question that matters for this platform: does the restored copy still
# refuse one tenant access to another tenant's rows?
#
# It NEVER drops anything. There is no DROP DATABASE in this file, deliberately
# (docs/39 §2): a drill that runs beside production with rights to everything
# and also knows how to drop databases is one typo from being the incident it
# was written to prevent. It prints the cleanup command instead.
#
#   scripts/restore-drill.sh                 # uses AVIORA_DATABASE_URL
#   SOURCE_URL=postgres://... scripts/restore-drill.sh
#
set -euo pipefail

SOURCE_URL="${SOURCE_URL:-${AVIORA_DATABASE_URL:-}}"
if [[ -z "$SOURCE_URL" ]]; then
  echo "set SOURCE_URL or AVIORA_DATABASE_URL" >&2
  exit 2
fi

# Everything runs through the container's own client so the drill uses the same
# major version as the server. A restore verified with a different pg_restore
# is a restore verified with a different tool than the one on the box.
CONTAINER="${AVIORA_DB_CONTAINER:-aviora_db}"
STAMP="$(date +%Y%m%d%H%M%S)"
SCRATCH="aviora_drill_${STAMP}"
WORK="${TMPDIR:-/tmp}/aviora-drill-${STAMP}"
mkdir -p "$WORK"

# postgres://user:pw@host:port/db
proto_less="${SOURCE_URL#*://}"
creds="${proto_less%%@*}"
hostpart="${proto_less#*@}"
DB_USER="${creds%%:*}"
DB_NAME="${hostpart#*/}"
DB_NAME="${DB_NAME%%\?*}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail_count=0
check() { # check <name> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %-46s %s\n' "$1" "$2"
  else
    printf '  ✗ %-46s expected %s, got %s\n' "$1" "$2" "$3"
    fail_count=$((fail_count + 1))
  fi
}
psql_src() { docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "$1"; }
psql_dst() { docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$SCRATCH" -tA -c "$1"; }

say "1. Dump ${DB_NAME}"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f "/tmp/${STAMP}.dump"
docker exec "$CONTAINER" sh -c "ls -l /tmp/${STAMP}.dump" | awk '{print "  " $5 " bytes"}'

# Roles are CLUSTER scope and are not in a database dump (docs/39 §1). A backup
# plan that takes only the file above restores a database whose security model
# has no subject, so the drill takes the second file and says so.
say "2. Dump cluster roles (the file a database dump does NOT contain)"
docker exec "$CONTAINER" pg_dumpall -U "$DB_USER" --roles-only -f "/tmp/${STAMP}.roles.sql"
docker exec "$CONTAINER" sh -c "grep -c 'CREATE ROLE' /tmp/${STAMP}.roles.sql" \
  | awk '{print "  " $1 " roles"}'

say "3. Restore into ${SCRATCH}"
docker exec "$CONTAINER" createdb -U "$DB_USER" "$SCRATCH"
# --no-owner is wrong here on purpose: ownership and grants are part of what is
# being verified, so the restore is done the way a real recovery would be.
docker exec "$CONTAINER" pg_restore -U "$DB_USER" -d "$SCRATCH" --exit-on-error \
  "/tmp/${STAMP}.dump" >/dev/null
echo "  restored"

say "4. Structure"
check "tables" \
  "$(psql_src "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")" \
  "$(psql_dst "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
check "RLS enabled" \
  "$(psql_src "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity")" \
  "$(psql_dst "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity")"
# The one most likely to be lost and least likely to be noticed: without FORCE,
# the owner role reads straight through every policy.
check "RLS forced" \
  "$(psql_src "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relforcerowsecurity")" \
  "$(psql_dst "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relforcerowsecurity")"
check "policies" \
  "$(psql_src "SELECT count(*) FROM pg_policy")" \
  "$(psql_dst "SELECT count(*) FROM pg_policy")"
check "policy expressions (hashed)" \
  "$(psql_src "SELECT md5(string_agg(polname || pg_get_expr(polqual, polrelid), ',' ORDER BY polname, polrelid::regclass::text)) FROM pg_policy")" \
  "$(psql_dst "SELECT md5(string_agg(polname || pg_get_expr(polqual, polrelid), ',' ORDER BY polname, polrelid::regclass::text)) FROM pg_policy")"
check "grants to aviora_app" \
  "$(psql_src "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='aviora_app'")" \
  "$(psql_dst "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='aviora_app'")"
check "migrations applied" \
  "$(psql_src "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")" \
  "$(psql_dst "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")"

say "5. Contents — every table with rows, not a sample"
mismatch=0
while IFS='|' read -r table src_rows; do
  [[ -z "$table" ]] && continue
  dst_rows="$(psql_dst "SELECT count(*) FROM \"$table\"")"
  if [[ "$src_rows" != "$dst_rows" ]]; then
    printf '  ✗ %-46s %s → %s\n' "$table" "$src_rows" "$dst_rows"
    mismatch=$((mismatch + 1))
  fi
done < <(psql_src "
  SELECT relname || '|' || n_live_tup FROM pg_stat_user_tables
   WHERE schemaname='public' AND n_live_tup > 0 ORDER BY relname")
if [[ "$mismatch" -eq 0 ]]; then
  echo "  ✓ every populated table matched"
else
  fail_count=$((fail_count + mismatch))
fi

say "6. Isolation, in the restored copy"
# The only check that tests BEHAVIOUR rather than the catalogue: become the app
# role, claim to be one tenant, and try to read rows belonging to another.
#
# It must pick a tenant that HAS rows, and prove they are there first. The first
# version of this check counted another tenant's goals, got zero, and reported
# success — those two tenants had no goals at all. A probe that passes because
# there was nothing to see is not evidence of isolation, so the visible-to-owner
# count is asserted before the invisible-to-app-role one.
PROBE_TABLE="${PROBE_TABLE:-members}"
read -r VICTIM VICTIM_ROWS < <(psql_dst "
  SELECT tenant_id || ' ' || count(*) FROM \"${PROBE_TABLE}\"
   WHERE tenant_id IS NOT NULL GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 1")
INTRUDER="$(psql_dst "SELECT id FROM tenants WHERE id <> '${VICTIM:-00000000-0000-0000-0000-000000000000}' LIMIT 1")"

if [[ -z "${VICTIM:-}" || -z "$INTRUDER" ]]; then
  printf '  ✗ %-46s %s\n' "isolation probe" \
    "no tenant pair with rows in ${PROBE_TABLE} — nothing to prove isolation WITH"
  fail_count=$((fail_count + 1))
else
  echo "  probing ${PROBE_TABLE}: ${VICTIM_ROWS} rows owned by one tenant, read as another"
  check "rows exist to be hidden (owner sees them)" "true" \
    "$([[ "$VICTIM_ROWS" -gt 0 ]] && echo true || echo false)"
  leaked="$(docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$SCRATCH" -tA <<SQL | tail -n 1
SET ROLE aviora_app;
SELECT set_config('app.tenant_id', '${INTRUDER}', false);
SELECT count(*) FROM "${PROBE_TABLE}" WHERE tenant_id = '${VICTIM}';
SQL
)"
  check "rows of another tenant visible to the app role" "0" "$leaked"
fi

say "Result"
if [[ "$fail_count" -eq 0 ]]; then
  echo "  PASS — the restored database is the same database, and still isolates tenants"
else
  echo "  FAIL — $fail_count check(s) did not match"
fi
cat <<TXT

  Scratch database left in place on purpose, so the result can be inspected.
  This script drops nothing (docs/39 §2). To clean up:

      docker exec ${CONTAINER} dropdb -U ${DB_USER} ${SCRATCH}
      docker exec ${CONTAINER} rm -f /tmp/${STAMP}.dump /tmp/${STAMP}.roles.sql
TXT
exit $(( fail_count > 0 ? 1 : 0 ))
