# 36 — Observability Contract (Sprint 17)

> Spec §68 (Observability). The last section of the spec with no line in the
> scorecard, and the one several named risks depend on: docs/33 §3 asks an
> operator to _look_ for stale scheduler runs, and docs/28 §6 says AI cost is
> "not yet measured" rather than show a fabricated zero. Both are answered here.

## 1. Nothing new is stored

Every measure is computed from the tables that already own the data — the
outbox, `scheduled_job_runs`, `ai_usage`, members, orders, audit. This is the
same rule analytics follows (docs/28 §1), and for the same reason: a metric
with its own table is a metric that can disagree with the thing it measures.

The one exception is a **rate card** for AI pricing, and it is a constant, not a
table — see §5.

## 2. Every log line says who, which tenant, and which request

```
request_id   the incoming X-Request-Id, or one generated here
tenant_id    the tenant the guards RESOLVED
user_id      the user the token proved
member_id    where the request has one
```

These come from CLS — what the guards concluded — and never from the request
headers, which are what the caller **claimed**. `x-tenant-id` is a header a
caller can write anything into; logging it as `tenant_id` would build an audit
trail out of assertions and quietly make cross-tenant investigation useless.
A request rejected before the tenant resolves logs no tenant, rather than
logging the one it asked for.

`X-Request-Id` is echoed back on every response — set by the interceptor on the
way through, and by the exception filter as well, because a request refused by a
guard never reaches an interceptor and those are exactly the responses people
open tickets about. The id in the header and the id in the error body are always
the same one.

**A webhook delivery is not part of that request.** It carries its own
`X-Aviora-Delivery` id and fires from the dispatcher minutes later, sometimes
from a scheduler tick that no request caused at all. Correlating a delivery back
to the request that produced its event would mean storing `request_id` on
`domain_events` and threading it through every producer that appends one — a
change across every module, which is not something to smuggle into an
observability sprint. It is named here as the tracing that does **not** exist:
an event is traceable today to its actor and its time, not to a request.

## 3. Errors are findable without a stack in the customer's face

The exception filter already answers with a code. It now also logs, at one
level per class:

| Class   | Logged           | Why                                                                |
| ------- | ---------------- | ------------------------------------------------------------------ |
| 5xx     | `error` + stack  | Ours. The stack is the only thing that finds it.                   |
| 4xx     | `warn`, no stack | The caller's. A stack here is noise that hides the 5xx next to it. |
| 401/403 | `warn` + code    | Named, because a burst of them is an attack or a broken client.    |

No error body ever carries a stack, an internal id, or a database message —
that rule is unchanged (docs/10). This is about the log, not the response.

## 4. What an operator can ask

| Method | Path                              | Gate                     | Answers                                                      |
| ------ | --------------------------------- | ------------------------ | ------------------------------------------------------------ |
| `GET`  | `/platform/observability/queue`   | platform role            | Outbox: pending, failed, oldest unprocessed, attempts spread |
| `GET`  | `/platform/observability/jobs`    | platform role            | Scheduler runs by status, and **runs left claimed**          |
| `GET`  | `/platform/observability/ai`      | platform role            | Requests, tokens and cost by tenant and model                |
| `GET`  | `/platform/observability/tenants` | platform role            | Per-tenant usage: members, orders, events, AI                |
| `GET`  | `/tenant/usage`                   | `tenant.settings.manage` | The same numbers, for the caller's own tenant only           |

The platform routes gate on the platform **role**, not on `platform.metrics.view`.
This contract first said the permission key, and the analytics module had
already settled the argument the other way (docs/28 §1): permission keys are
granted _per tenant_, so a key cannot express "may see across all of them". The
key remains in the catalogue for a tenant-scoped metrics surface; nothing
cross-tenant may rest on it.

`/platform/observability/jobs` is the answer to the manual step docs/35 §5
names: a run `claimed` for longer than a threshold is a job nobody ran, and it
is reported as `stale`, with its age, rather than left for somebody to notice.

`/tenant/usage` exists because a tenant asking "how much of this am I using"
should not have to ask us. It reads the same computation at tenant scope, so
the two cannot drift.

It reports **usage without cost**. Requests and tokens are the tenant's own
activity; the cost beside them is what the _platform_ pays a provider, and
handing a tenant our provider bill hands them our margin. If a tenant is ever
charged for AI, that price is a commercial decision with a number of its own —
not this one leaking through a metrics endpoint.

## 5. AI cost is tokens times a rate that is written down

```
AI_RATE_CARD  provider · model · inputMinorPerMillion · outputMinorPerMillion · currency
```

A constant in `@aviora/shared`, with the date it was taken and its source in a
comment beside it. A rate card in the database would be a number anyone could
change with no review, and it is a **platform** fact — no tenant has their own
price for the same model.

Where a model has **no rate**, the cost is `null` and the response says
`"no rate configured for <model>"`. It is never `0`. Zero is a number an
operator will budget against; null is a question they will answer. This is what
docs/28 §6 refused to guess, now given a real answer wherever a rate exists.

Cost is reported in **minor units**, like all money on this platform. It is an
_estimate of provider spend_, and every response says so — it is not billing,
and nothing charges a tenant from it.

## 6. What this refuses

- **No APM vendor.** Sentry, Datadog and the rest are one env var and a decision
  about shipping customer data to a third party. The seam is the exception
  filter and the logger; the decision is not ours to make silently.
- **No per-request metrics table.** Counting every request into Postgres is how
  a slow time-series database gets built. The log line is the record; if a
  histogram is needed, it belongs in something made for it.
- **No distributed tracing.** One process, one request id. Spans across
  services would describe a topology that does not exist.
- **No infrastructure cost.** Nothing inside the app meters the machine it runs
  on. It is named as unmeasured rather than estimated.
