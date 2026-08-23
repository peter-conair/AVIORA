## Running the checks (Sprint 45)

```bash
pnpm verify
```

lint → typecheck → unit → integration, in the order that works, with the dev API
stopped first. Browser tests stay separate because they need both servers up:

```bash
pnpm --filter @aviora/web exec playwright test
```

### Two traps this removes

**A running dev API drains the tests' outbox.** The relay is cross-tenant by
design (`FOR UPDATE SKIP LOCKED`), so an API on 3021 eats the events the
integration suite is waiting for and suites report "outbox did not drain" —
a failure that looks like a product bug and is not. `verify` stops it first.

**A build used to corrupt the dev server's `.next`.** `turbo typecheck` depends
on `build`, so every check run wrote into the directory the dev server was
serving from, and every page then 500s with a JSON parse error naming no file.
The cure was always the same: kill the server, delete the directory, start
again — several minutes, on most sprints.

Fixed rather than worked around: `apps/web/next.config.ts` sets
`distDir: process.env.NEXT_DIST_DIR ?? '.next'` and the `build` script sets
`NEXT_DIST_DIR=.next-build`. A build and a dev server no longer share an output
directory, so checks are safe to run beside a running server. CI is unaffected —
its browser job runs `pnpm dev`, which still uses `.next`.
