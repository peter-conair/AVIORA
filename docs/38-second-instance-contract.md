# 38 — Running More Than One Instance (Sprint 19)

> docs/33 §3 lists what the platform claims but has not proved. Three of those
> entries are the same sentence in different words: **nothing has ever run two
> API processes at once.** This sprint runs two, and either proves each claim or
> changes it.

## 1. What a second instance breaks

| Component    | Claim today                                 | What two processes do to it                                                  |
| ------------ | ------------------------------------------- | ---------------------------------------------------------------------------- |
| Rate limiter | "120 requests a minute"                     | Counts per process, so two instances allow 240. The stated limit is a lie.   |
| Scheduler    | One run per job, per tenant, per occurrence | Both tick. The advisory lock and unique key are supposed to hold — untested. |
| Outbox relay | Each event handled once                     | Both poll. `FOR UPDATE SKIP LOCKED` is supposed to hold — untested.          |

The rate limiter is the one that is actually wrong. The other two are designs
that were built for this and never made to prove it, which is a different kind
of risk: they are probably right, and "probably" is not what a payment or a
webhook signature deserves.

## 2. The rate limiter counts in Redis

`INCR` on the key the limiter already builds, with `EXPIRE` on first write —
the upgrade the class named for itself. One budget, however many instances.

The response contract does not change. The limit was always stated in the
headers rather than in documentation precisely so this swap would be invisible
to a caller.

**When Redis is unreachable, the limiter fails OPEN and says so in the log.**
This is a deliberate choice and the reasoning belongs in writing: a limiter that
fails closed converts "the cache is down" into "the whole public API is down",
turning a degraded dependency into an outage. The exposure while Redis is
unreachable is that callers are limited per process, which is exactly where this
sprint found things — an already-survived state, not a new one.

If `AVIORA_REDIS_URL` is unset the limiter stays in memory, with the same
honesty: a single-instance deployment does not need Redis to be correct.

One detail found by testing it and worth keeping: the client's **offline queue
stays on**. The obvious setting for a fail-open limiter is to turn it off, so a
dead Redis errors instantly instead of queueing — but with it off, every command
issued before the socket finishes connecting also fails instantly, so a freshly
started process counts per-process for its first requests. That is exactly when
a restart storm makes the shared limit matter. With the queue on, those commands
wait for the connection and are still bounded by a 250 ms command timeout, so a
genuinely dead Redis costs a quarter-second and falls back.

## 3. The scheduler and the outbox are made to prove it

Neither gets new code. Both get a test that runs **two application instances
against one database** and asserts the invariant each was built for:

- **Scheduler.** Both instances tick the same occurrence at the same moment.
  Exactly one `scheduled_job_runs` row exists, one renewal order was made, and
  the losing instance recorded nothing. If the advisory lock were wrong, this
  is where a subscription gets billed twice.
- **Outbox.** Both relays drain one backlog concurrently. Every event ends
  `processed`, and each handler ran once — `processed_events` is the ledger
  that answers it.

A test that starts two Nest applications is slower and stranger than the rest of
the suite. It is worth it: the alternative is finding out in production, on the
day someone scales the deployment, that "exactly once" meant "exactly once per
process".

## 4. What this does not do

- **No BullMQ.** Moving the outbox to a real queue is still the documented
  upgrade (docs/11), and it is a bigger change than one sprint. What this proves
  is that the current relay is safe to run twice — which is what would happen
  first, and what nobody had checked.
- **No leader election.** The scheduler deliberately has none (docs/35 §6): the
  unique key already means only one instance can own an occurrence, and adding
  a coordination protocol to a problem the database already solves buys a new
  failure mode and no correctness.
- **No session or cache moved to Redis.** Only the counter that is provably
  wrong without it. A Redis dependency earns its way in one use at a time.
