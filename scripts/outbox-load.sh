#!/usr/bin/env bash
#
# Outbox throughput measurement (docs/41). Runs against a SCRATCH COPY of the
# database, like the restore drill and the migration rehearsal — a load test
# that fills somebody's development outbox with a hundred thousand events is a
# load test they only run once.
#
# Drops nothing. Cleanup commands are printed at the end.
set -euo pipefail

SOURCE_URL="${SOURCE_URL:-${AVIORA_DATABASE_URL:-}}"
[[ -z "$SOURCE_URL" ]] && { echo "set AVIORA_DATABASE_URL" >&2; exit 2; }

CONTAINER="${AVIORA_DB_CONTAINER:-aviora_db}"
STAMP="$(date +%Y%m%d%H%M%S)"
LOAD_DB="aviora_obload_${STAMP}"

proto_less="${SOURCE_URL#*://}"
creds="${proto_less%%@*}"; hostpart="${proto_less#*@}"
DB_USER="${creds%%:*}"; DB_PASS="${creds#*:}"
DB_NAME="${hostpart#*/}"; DB_NAME="${DB_NAME%%\?*}"
HOSTPORT="${hostpart%%/*}"

echo "Copying ${DB_NAME} into ${LOAD_DB}"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f "/tmp/${STAMP}.ob.dump"
docker exec "$CONTAINER" createdb -U "$DB_USER" "$LOAD_DB"
docker exec "$CONTAINER" pg_restore -U "$DB_USER" -d "$LOAD_DB" --exit-on-error "/tmp/${STAMP}.ob.dump" >/dev/null

APP_PASS="${AVIORA_APP_DATABASE_URL#*://}"; APP_PASS="${APP_PASS%%@*}"; APP_PASS="${APP_PASS#*:}"
# Run through vitest's SWC pipeline rather than tsx: esbuild does not emit
# decorator metadata, so Nest cannot wire its dependency graph under tsx — the
# app boots with an undefined PrismaService. The load config is separate from
# the integration one so this never runs on a push.
AVIORA_DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${HOSTPORT}/${LOAD_DB}" \
AVIORA_APP_DATABASE_URL="postgresql://aviora_app:${APP_PASS}@${HOSTPORT}/${LOAD_DB}" \
  pnpm --filter @aviora/api exec vitest run --config vitest.load.config.ts

cat <<TXT
  Nothing was dropped. To clean up:

      docker exec ${CONTAINER} dropdb -U ${DB_USER} ${LOAD_DB}
      docker exec ${CONTAINER} rm -f /tmp/${STAMP}.ob.dump
TXT
