#!/usr/bin/env bash
#
# CRM contact encryption rehearsal (docs/54).
#
# Encrypting `leads` / `customers` name, email and phone is the one-way door
# docs/13 §11.1 declined to walk through. This walks through it on a scratch
# COPY, so the question "would it work, and would anything be lost" has an
# answer that came from running it rather than from reasoning about it.
#
# What it does NOT do: touch the database you are using. It copies, migrates
# the copy, verifies the copy, and drops nothing (docs/39 §2). Cleanup commands
# are printed at the end for you to run.
#
#   scripts/crm-encryption-rehearsal.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
SOURCE_URL="${AVIORA_DATABASE_URL:-}"
[[ -z "$SOURCE_URL" ]] && { echo "set AVIORA_DATABASE_URL" >&2; exit 2; }

CONTAINER="${AVIORA_DB_CONTAINER:-aviora_db}"
rest="${SOURCE_URL#*://}"; creds="${rest%%@*}"; hostpart="${rest#*@}"
DB_USER="${creds%%:*}"; DB_PASS="${creds#*:}"
DB_NAME="${hostpart#*/}"; DB_NAME="${DB_NAME%%\?*}"
HOSTPORT="${hostpart%%/*}"
STAMP="$(date +%Y%m%d%H%M%S)"
SCRATCH="aviora_crmreh_${STAMP}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1. Copy ${DB_NAME} into ${SCRATCH} (the real one is not touched)"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f "/tmp/${STAMP}.crm.dump"
docker exec "$CONTAINER" createdb -U "$DB_USER" "$SCRATCH"
docker exec "$CONTAINER" pg_restore -U "$DB_USER" -d "$SCRATCH" --exit-on-error "/tmp/${STAMP}.crm.dump" >/dev/null
echo "  copied"

say "2. Add the blind-index columns to the copy"
# Exactly the DDL the real migration would run: additive, nullable, and
# reversible on its own — the irreversible part is the UPDATE in step 3.
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$SCRATCH" -q -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE leads     ADD COLUMN IF NOT EXISTS email_bidx text,
                      ADD COLUMN IF NOT EXISTS phone_bidx text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_bidx text,
                      ADD COLUMN IF NOT EXISTS phone_bidx text;
-- tenant_id first: every CRM lookup is already inside one tenant, and the
-- index is useless to a query that has to scan tenants to use it (docs/08 §43).
CREATE INDEX IF NOT EXISTS leads_tenant_email_bidx_idx     ON leads     (tenant_id, email_bidx);
CREATE INDEX IF NOT EXISTS leads_tenant_phone_bidx_idx     ON leads     (tenant_id, phone_bidx);
CREATE INDEX IF NOT EXISTS customers_tenant_email_bidx_idx ON customers (tenant_id, email_bidx);
CREATE INDEX IF NOT EXISTS customers_tenant_phone_bidx_idx ON customers (tenant_id, phone_bidx);

-- Phones, synthesised INTO THE COPY ONLY.
--
-- No row in the real database has one, so without this the phone half of the
-- rehearsal iterates an empty list and reports success for a code path it
-- never ran — which is exactly what the first run of this script did. Phone
-- normalisation is the fiddliest part of the blind index (a Thai number has
-- three common spellings), so it is the last thing that should go unexercised.
UPDATE leads     SET phone = '08' || lpad(((abs(hashtext(id::text)) % 100000000))::text, 8, '0')
 WHERE phone IS NULL OR phone = '';
UPDATE customers SET phone = '08' || lpad(((abs(hashtext(id::text)) % 100000000))::text, 8, '0')
 WHERE phone IS NULL OR phone = '';
SQL
echo "  columns, indexes and rehearsal phones added"

say "3. Encrypt every contact column and verify nothing was lost"
AVIORA_REHEARSAL_DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${HOSTPORT}/${SCRATCH}" \
  pnpm --filter @aviora/api exec vitest run \
    --config vitest.load.config.ts test/load/crm-encryption-rehearsal.spec.ts

say "Done — nothing was dropped"
cat <<CLEAN
The scratch database is still there so you can look at it:

  docker exec -it ${CONTAINER} psql -U ${DB_USER} -d ${SCRATCH} \\
    -c "SELECT id, name, email, email_bidx FROM leads LIMIT 3;"

When you are finished with it, these are yours to run:

  docker exec ${CONTAINER} dropdb -U ${DB_USER} ${SCRATCH}
  docker exec ${CONTAINER} rm -f /tmp/${STAMP}.crm.dump
CLEAN
