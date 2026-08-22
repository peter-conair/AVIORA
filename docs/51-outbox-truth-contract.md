# 51 — Two Sentences in docs/11 That Were Not True (Sprint 32)

> Found by auditing `docs/11` the way the last five sprints were found. Two of
> its statements described behaviour the code does not have — one a test, one a
> component.

## 1. The test that was listed and never written

§321 lists, by name: _"outbox atomicity — force rollback after event append,
assert no event row"_.

It did not exist, and it is **the** property the transactional outbox is for: an
event is written in the same transaction as the state change it describes, so
the two can never disagree. Get it wrong and the failure is silent in both
directions:

- an event written **outside** the transaction announces work that rolled back —
  a member told they were invited to a tenancy that does not exist, a commission
  emitted for an order that did not survive;
- a state change written **without** its event is work nobody downstream ever
  hears about.

Neither shows up in a test that asserts happy paths, because on a happy path
both halves commit. `test/integration/outbox-atomicity.spec.ts` forces the
rollback, and also asserts the commit case — a test that only proves nothing is
written would pass against an `appendEvent` that does nothing at all — and the
state side, because the guarantee runs both ways.

**It passes.** Atomicity was correct all along; nothing had checked.

## 2. The dead-letter queue that was described and never built

§273 claims a poison-pill guard: _"payloads failing zod validation go straight
to DLQ (no retries — they will never succeed)."_

There is no DLQ, and the relay does not validate payloads. What actually
happens: a handler that throws backs off exponentially, and once `attempts`
reaches `MAX_ATTEMPTS` the relay stops selecting the row — its query is
`attempts < MAX_ATTEMPTS`. The event stays in `domain_events`, unprocessed, for
ever.

That was **not** invisible: `outbox.failing` counts everything with an error, so
a dead event fed that number. But it lumped two different situations together,
and the difference is the whole question an operator has:

|             |                                                      |
| ----------- | ---------------------------------------------------- |
| **failing** | erroring, and the relay will try again               |
| **dead**    | exhausted, and the relay will never look at it again |

So `dead` is now counted and reported separately, and `outbox.dead` alerts on
the **first** one — one event nobody will ever retry is already worth a person's
attention.

Both numbers derive from `MAX_ATTEMPTS` imported from the relay, not a copy: a
second copy of that constant is precisely how a report drifts from the thing it
reports on.

## 3. Why a counter instead of a DLQ

A dead-letter queue is a better home for these — somewhere to inspect, fix and
replay a payload without hand-writing SQL. It is also a table, a replay path, an
admin screen and a set of decisions about who may replay what.

What was actually wrong was not the absence of the queue; it was that **the
document promised one and an operator had no way to know these events existed.**
A number they are told about fixes that today. docs/11 now says so, and says a
DLQ would be better, rather than continuing to describe one that is not there.
