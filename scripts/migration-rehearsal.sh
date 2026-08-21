#!/usr/bin/env bash
#
# Tenant migration rehearsal at volume (docs/40).
#
# docs/33 §3 has said the dedicated-database move has "never been run at
# volume". This runs it: inflates one tenant in a scratch COPY of the database,
# then extracts, restores and verifies it into a second scratch database,
# reporting how long each step took and how big the file was.
#
# The numbers are the point. Correctness is checked by `tenant:migrate verify`,
# which does not get weaker with size; what size tells you is how long the
# tenant is read-only, which is what decides whether a migration is a
# maintenance note or an incident.
#
# Nothing here touches the database anybody is using, and nothing is dropped
# (docs/39 §2, docs/40 §2). Cleanup commands are printed at the end.
#
#   scripts/migration-rehearsal.sh
#   MEMBERS=50000 EVENTS=250000 scripts/migration-rehearsal.sh
#
set -euo pipefail

SOURCE_URL="${SOURCE_URL:-${AVIORA_DATABASE_URL:-}}"
[[ -z "$SOURCE_URL" ]] && { echo "set AVIORA_DATABASE_URL" >&2; exit 2; }

CONTAINER="${AVIORA_DB_CONTAINER:-aviora_db}"
STAMP="$(date +%Y%m%d%H%M%S)"
SRC_DB="aviora_migsrc_${STAMP}"
DST_DB="aviora_migdst_${STAMP}"

MEMBERS="${MEMBERS:-20000}"
ORDERS="${ORDERS:-40000}"
ITEMS="${ITEMS:-80000}"
EVENTS="${EVENTS:-100000}"
NOTIFS="${NOTIFS:-100000}"

proto_less="${SOURCE_URL#*://}"
creds="${proto_less%%@*}"
hostpart="${proto_less#*@}"
DB_USER="${creds%%:*}"
DB_PASS="${creds#*:}"
DB_NAME="${hostpart#*/}"; DB_NAME="${DB_NAME%%\?*}"
HOSTPORT="${hostpart%%/*}"

dsn_for() { echo "postgresql://${DB_USER}:${DB_PASS}@${HOSTPORT}/$1"; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
q_src() { docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$SRC_DB" -tA -c "$1"; }
# Seconds with a decimal, from a monotonic-enough clock available on macOS bash 3.
now() { python3 -c 'import time;print(f"{time.monotonic():.3f}")'; }
took() { python3 -c "print(f'{float('$2')-float('$1'):.1f}s')"; }

say "1. Copy the database into ${SRC_DB} (the real one is not touched)"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f "/tmp/${STAMP}.src.dump"
docker exec "$CONTAINER" createdb -U "$DB_USER" "$SRC_DB"
docker exec "$CONTAINER" pg_restore -U "$DB_USER" -d "$SRC_DB" --exit-on-error "/tmp/${STAMP}.src.dump" >/dev/null
echo "  copied"

TENANT="$(q_src "
  SELECT t.id FROM tenants t
   JOIN members m ON m.tenant_id = t.id
  GROUP BY t.id ORDER BY count(*) DESC LIMIT 1")"
[[ -z "$TENANT" ]] && { echo "no tenant with members to inflate" >&2; exit 2; }
echo "  inflating tenant ${TENANT}"

say "2. Inflate to volume"
INFLATE_START="$(now)"
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$SRC_DB" -q -v ON_ERROR_STOP=1 <<SQL
-- A user per member, because members is UNIQUE (tenant_id, user_id): one
-- person is one member of a tenant. These users are created here and are NOT
-- part of what moves — users are platform-global (docs/32 §1), which is the
-- manual step §4.4 exists for. Inflating them alongside makes the rehearsal
-- carry that asymmetry rather than pretend it away.
INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
SELECT gen_random_uuid(), 'load-${STAMP}-' || g || '@rehearsal.local',
       'not-a-real-hash', 'Load User ' || g, now(), now()
  FROM generate_series(1, ${MEMBERS}) g;

-- Members: the row every other tenant table points at.
INSERT INTO members (id, tenant_id, user_id, display_name, status, joined_at, created_at, updated_at)
SELECT gen_random_uuid(), '${TENANT}', u.id, 'Load Member ' || u.display_name,
       'active', now(), now(), now()
  FROM users u
 WHERE u.email LIKE 'load-${STAMP}-%@rehearsal.local';

INSERT INTO orders (id, tenant_id, member_id, number, status, currency,
                    subtotal_minor, discount_minor, total_minor, placed_at)
SELECT gen_random_uuid(), '${TENANT}',
       (SELECT id FROM members WHERE tenant_id = '${TENANT}' OFFSET (g % ${MEMBERS}) LIMIT 1),
       'LOAD-' || g, 'paid', 'THB', 100000, 0, 100000, now()
  FROM generate_series(1, ${ORDERS}) g;

-- One offering to hang the line items off. order_items.offering_id is a real
-- foreign key, so inventing uuids here would only prove the FK works.
INSERT INTO offerings (id, tenant_id, code, name, currency, price_minor, status, created_at, updated_at)
VALUES (gen_random_uuid(), '${TENANT}', 'load-${STAMP}', 'Rehearsal offering',
        'THB', 100000, 'active', now(), now());

INSERT INTO order_items (id, tenant_id, order_id, offering_id, name, quantity,
                         unit_price_minor, line_total_minor)
SELECT gen_random_uuid(), '${TENANT}', o.id,
       (SELECT id FROM offerings WHERE code = 'load-${STAMP}'),
       'Load item', 1, 100000, 100000
  FROM (SELECT id, row_number() OVER () rn FROM orders
         WHERE tenant_id = '${TENANT}' AND number LIKE 'LOAD-%') o,
       generate_series(1, GREATEST(1, ${ITEMS} / GREATEST(1, ${ORDERS}))) g;

INSERT INTO domain_events (id, event_name, tenant_id, aggregate_type, aggregate_id,
                           payload, occurred_at, processed_at)
SELECT gen_random_uuid(), 'load.event', '${TENANT}', 'load', gen_random_uuid(),
       jsonb_build_object('n', g, 'note', 'rehearsal filler'), now(), now()
  FROM generate_series(1, ${EVENTS}) g;

INSERT INTO notifications (id, tenant_id, member_id, type, title, body, created_at)
SELECT gen_random_uuid(), '${TENANT}',
       (SELECT id FROM members WHERE tenant_id = '${TENANT}' OFFSET (g % ${MEMBERS}) LIMIT 1),
       'load', 'Load notification ' || g, 'filler', now()
  FROM generate_series(1, ${NOTIFS}) g;

ANALYZE;
SQL
INFLATE_END="$(now)"
TOTAL_ROWS="$(q_src "
  SELECT (SELECT count(*) FROM members WHERE tenant_id='${TENANT}')
       + (SELECT count(*) FROM orders WHERE tenant_id='${TENANT}')
       + (SELECT count(*) FROM order_items WHERE tenant_id='${TENANT}')
       + (SELECT count(*) FROM domain_events WHERE tenant_id='${TENANT}')
       + (SELECT count(*) FROM notifications WHERE tenant_id='${TENANT}')")"
echo "  $(took "$INFLATE_START" "$INFLATE_END") — ${TOTAL_ROWS} rows in the five inflated tables"

say "3. Destination database with the same schema"
docker exec "$CONTAINER" createdb -U "$DB_USER" "$DST_DB"
AVIORA_DATABASE_URL="$(dsn_for "$DST_DB")" \
  pnpm --filter @aviora/db exec prisma migrate deploy >/dev/null
echo "  migrated"

say "4. Plan (the dry run an operator runs days earlier)"
PLAN_START="$(now)"
pnpm --filter @aviora/db tenant:migrate plan \
  --tenant "$TENANT" --source "$(dsn_for "$SRC_DB")" 2>&1 | tail -5
PLAN_END="$(now)"

say "5. Extract — the tenant is read-only from here"
OUT="${TMPDIR:-/tmp}/rehearsal-${STAMP}.sql"
EXTRACT_START="$(now)"
pnpm --filter @aviora/db tenant:migrate extract \
  --tenant "$TENANT" --source "$(dsn_for "$SRC_DB")" --out "$OUT" 2>&1 | tail -3
EXTRACT_END="$(now)"
FILE_MB="$(python3 -c "import os;print(f'{os.path.getsize('$OUT')/1048576:.1f}')")"
echo "  $(took "$EXTRACT_START" "$EXTRACT_END") — ${FILE_MB} MB"

say "6. Restore"
RESTORE_START="$(now)"
PGPASSWORD="$DB_PASS" docker exec -i "$CONTAINER" \
  psql -U "$DB_USER" -d "$DST_DB" -q -v ON_ERROR_STOP=1 -f - < "$OUT" >/dev/null
RESTORE_END="$(now)"
echo "  $(took "$RESTORE_START" "$RESTORE_END")"

say "7. Verify — the tenant is writable again after this"
VERIFY_START="$(now)"
set +e
pnpm --filter @aviora/db tenant:migrate verify \
  --tenant "$TENANT" --source "$(dsn_for "$SRC_DB")" --target "$(dsn_for "$DST_DB")" 2>&1 | tail -4
VERIFY_RC=${PIPESTATUS[0]}
set -e
VERIFY_END="$(now)"
echo "  $(took "$VERIFY_START" "$VERIFY_END")"

READONLY="$(python3 -c "print(f'{float('$VERIFY_END')-float('$EXTRACT_START'):.1f}s')")"
say "Result"
cat <<TXT
  tenant            ${TENANT}
  rows moved        ${TOTAL_ROWS}
  extract file      ${FILE_MB} MB
  plan              $(took "$PLAN_START" "$PLAN_END")
  extract           $(took "$EXTRACT_START" "$EXTRACT_END")
  restore           $(took "$RESTORE_START" "$RESTORE_END")
  verify            $(took "$VERIFY_START" "$VERIFY_END")
  ── read-only window (extract → verified): ${READONLY}

  Nothing was dropped. To clean up:

      docker exec ${CONTAINER} dropdb -U ${DB_USER} ${SRC_DB}
      docker exec ${CONTAINER} dropdb -U ${DB_USER} ${DST_DB}
      docker exec ${CONTAINER} rm -f /tmp/${STAMP}.src.dump
      rm -f ${OUT}
TXT
exit $VERIFY_RC
