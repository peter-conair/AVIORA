# 41 — The Outbox at Rate (Sprint 22)

> docs/33 §3: _"BullMQ (docs/11) and a load test. Concurrency is proved; RATE is
> not — nothing has ever run it at volume."_ This measures the rate, and the
> measurement changes the relay.

## 1. What the measurement found

1,000 events per backlog, on a laptop, relay driven by hand with no wait
between calls:

| Backlog                     | Time | Rate           | What it isolates                   |
| --------------------------- | ---- | -------------- | ---------------------------------- |
| events **with** handlers    | 6.2s | 161 events/s   | the platform doing its actual work |
| events with **no** handlers | 0.4s | 2,400 events/s | the poller's own overhead          |

So the relay can move 161 events a second, and the machinery around the work
costs almost nothing next to the work itself. That is a healthy shape.

**And none of it reaches production**, because of this:

```
BATCH 20 per tick ÷ POLL_MS 2000ms  =  10 events per second per instance
```

The relay took one batch per tick and then waited two seconds. Its deployed
throughput was fixed by two constants before any database, handler or machine
was involved — sixteen times below what the same code achieves when asked to
keep working. A tenant emitting 20 events a second would fall permanently
behind, and the queue-depth panel added in docs/36 would show the backlog
growing for ever without anything being wrong with any single event.

This is the kind of thing a load test exists to find, and the kind of thing that
is invisible to every other kind of test: nothing is incorrect, nothing throws,
and every event is eventually delivered.

## 2. The change: POLL_MS becomes an idle interval, not a divisor

A tick now keeps taking batches until a batch comes back short, bounded by
`MAX_BATCHES_PER_TICK`:

```
tick → batch → batch → batch → … → short batch → stop
```

- **Short batch means done.** Fewer rows than `BATCH` means either the backlog
  is empty or another instance holds the rest under `SKIP LOCKED` — and in both
  cases the right move is to stop, not to spin.
- **The bound matters.** Without it one instance with a large backlog runs until
  the backlog ends, holding a connection and starving nothing but looking a lot
  like a hang. `MAX_BATCHES_PER_TICK` caps a single pass; the next tick picks up
  where it left off.
- **Each batch keeps its own transaction.** The loop does not widen the
  transaction — that would hold row locks across more handler I/O, which is the
  opposite of what this change is for.

With this, throughput is bounded by the handlers (161/s here) rather than by the
poll interval, and `POLL_MS` means only "how quickly a newly written event is
noticed when the queue is empty".

## 3. What this deliberately does not change

- **The transaction still spans one batch of dispatches.** A slow handler holds
  a database transaction open for the whole batch, and that is a real hazard
  worth naming rather than leaving implied. It is not fixed here because
  narrowing it to one transaction per event changes the failure semantics of a
  batch, and this sprint's claim is about rate. It is the next thing to do to
  this file.

  > **Corrected in Sprint 24 (docs/43 §1).** The example this paragraph
  > originally used — "a webhook with a long timeout" — was wrong: webhook
  > delivery does not happen inside the outbox transaction, because the handler
  > records a delivery row and the `webhook.sweep` job posts it later. The
  > handler that actually waits is **email**, whose transport had no timeouts at
  > all. The worry was right; the example was not. Both are fixed in docs/43.

- **BullMQ is still the documented upgrade** (docs/11). What this sprint
  establishes is that the in-process relay is not slow — it was throttled — so
  the queue is a scaling decision rather than a rescue.
- **No threshold is asserted.** `pnpm db:outbox-load` reports numbers and does
  not fail a build on them: a performance assertion that goes red on a busy
  laptop teaches people to ignore the suite. What IS asserted is that the
  backlog drains completely, and that one tick can now clear more than one
  batch — the arithmetic ceiling being gone is a behaviour, not a number.

## 4. Running it

```bash
pnpm db:outbox-load           # 2,000 events per backlog, against a scratch copy
COUNT=20000 pnpm db:outbox-load
```

It runs against a **scratch copy** of the database, like the restore drill and
the migration rehearsal: a load test that fills somebody's development outbox
with twenty thousand events is a load test they run once.
