# 43 — Handlers That Wait (Sprint 24)

> docs/41 §3 named the next thing to do to the relay: _"The transaction still
> spans one batch of dispatches. A slow handler — a webhook with a long timeout
> — holds a database transaction open for the whole batch."_
>
> Looking properly at it, that sentence was **wrong in its example and right in
> its worry**, which is worth correcting rather than quietly fixing.

## 1. The correction

Webhook delivery does **not** happen inside the outbox transaction. The handler
`webhook.deliveries` calls `record()`, which writes `webhook_deliveries` rows;
the HTTP POST happens later in the `webhook.sweep` job. That design is right,
and it is the pattern the rest of this section argues for.

The handler that actually waits is **email**. `email.invite` and `email.welcome`
call `sendMail` inline, and the transport was created with no timeouts at all:

| nodemailer default  | value      |
| ------------------- | ---------- |
| `connectionTimeout` | 2 min      |
| `greetingTimeout`   | 30 s       |
| `socketTimeout`     | **10 min** |

So an unresponsive mail server could hold an outbox transaction — and its row
locks, and a pool connection — for ten minutes per event, twenty events to a
batch. Nothing would look broken; the queue would simply stop moving, which is
precisely the failure Sprint 22 was about, arriving by a different road.

## 2. Two changes, in order of how much they buy

**Bound the transport.** Five seconds to connect, five to greet, ten on the
socket. An email that cannot be sent in ten seconds is not going to be sent, and
the outbox already retries with backoff — so a slow mail server becomes a
delayed email instead of a stalled queue.

**One transaction per event, not per batch.** The relay still takes a batch of
ids, but each event is dispatched and settled in its own short transaction. The
worst case stops multiplying by the batch size: one slow handler delays one
event rather than nineteen others.

This costs round trips — twenty transactions where there was one — so it is
measured rather than assumed, with the harness Sprint 22 built. The numbers are
in §4.

## 3. What stays as it is

- **Handlers may still do I/O.** The rule this sprint does NOT introduce is
  "handlers must be pure". The email handler doing its own sending is honest and
  readable; what was wrong was that nothing bounded it.
- **`SKIP LOCKED` still does the arbitration.** Each per-event transaction takes
  its own row lock, so two relays still cannot take the same event — the
  property `second-instance.e2e.spec.ts` asserts, unchanged.
- **A failed event still backs off.** Per-event transactions mean a failure
  rolls back only that event's work, which is strictly better than a batch
  where one late failure could roll back nineteen successful updates.

## 4. What the change cost, measured

Same harness as docs/41, 1,000 events per backlog, on the same machine:

| Backlog                     | Batch transaction | Per-event transaction | Change |
| --------------------------- | ----------------- | --------------------- | ------ |
| events **with** handlers    | 157 events/s      | **125 events/s**      | −20%   |
| events with **no** handlers | 2,089 events/s    | **627 events/s**      | −70%   |

The second row is the honest one to look at first: with the work removed, all
that is left is transaction overhead, and twenty transactions cost roughly three
times one. That is the price, stated plainly.

It is worth paying here, and the reason is not the average — it is the tail. The
throughput that matters is still 125 events a second, twelve times the ceiling
the relay actually shipped with until Sprint 22. What changes is the worst case:
a mail server that stops answering used to hold one transaction, and nineteen
other events' row locks, for as long as it took to give up — up to ten minutes
per event before §2 bounded the transport. Now it holds one event's lock for at
most ten seconds, and the other nineteen are already gone.

A queue that is 20% slower and cannot be stalled by one unresponsive dependency
is a better queue than a fast one that can.

**If this becomes the bottleneck**, the answer is not to widen the transaction
again — it is BullMQ (docs/11), which is the documented upgrade and does not
make this trade at all.
