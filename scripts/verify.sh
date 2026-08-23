#!/usr/bin/env bash
#
# Everything that can be checked without a browser, in one command and in the
# order that actually works.
#
# Two things about this repo make hand-sequencing error-prone, and both cost
# minutes every time somebody gets them wrong:
#
#   1. A RUNNING DEV API DRAINS THE TESTS' OUTBOX. The relay is cross-tenant by
#      design (FOR UPDATE SKIP LOCKED), so an API on 3021 eats the events the
#      integration suite is waiting for and suites report "outbox did not
#      drain". This kills it first.
#   2. Builds used to corrupt the dev server's `.next`. Fixed properly instead
#      of worked around — a build writes to `.next-build` now
#      (apps/web/next.config.ts) — so lint and typecheck are safe to run beside
#      a running dev server, which they were not before.
#
# Browser tests are NOT here: they need the API and web running, which this
# script has just made sure is not the case for the API. Run them after,
# with both servers up:
#
#   pnpm --filter @aviora/web exec playwright test
#
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if lsof -ti:3021 >/dev/null 2>&1; then
  say "Stopping the dev API on 3021 (it would drain the tests' outbox)"
  lsof -ti:3021 | xargs kill -9 2>/dev/null || true
  sleep 1
fi

say "1/4  lint"
pnpm -s lint

say "2/4  typecheck"
pnpm -s typecheck

say "3/4  unit"
pnpm --filter @aviora/api test

# CI runs UTC and this machine does not; a test that reads a calendar boundary
# passes here and fails there unless it is run both ways (docs/36).
say "4/4  integration (TZ=UTC, as CI runs it)"
TZ=UTC pnpm --filter @aviora/api test:integration

say "Green. Browser tests still to run — start both servers, then:"
echo "  pnpm --filter @aviora/web exec playwright test"
