# 42 — Alerting Contract (Sprint 23)

> docs/33 §3, the last entry with something buildable behind it: _"Somebody is
> watching — the platform reports on itself (docs/36): queue depth, stale
> scheduler claims, AI spend per tenant. **A metric with no alert is a page
> nobody opens.**"_

## 1. Silence has to mean something

The failure this sprint is designed against is not "the alert did not fire". It
is **not being able to tell the difference between nothing being wrong and
nothing being checked** — which is the same shape as two things this codebase
has already been bitten by: a pre-commit guard registered so it never ran, and
an isolation probe that counted rows which did not exist. Both looked like
health. Both were silence.

So every answer this feature gives carries **when the checks last ran**. "No
alerts" from a sweep that ran ninety seconds ago is health; "no alerts" from a
sweep whose last run was yesterday is the thing to investigate. A reader must
never have to assume which one they are looking at.

## 2. The checks

Each reads numbers docs/36 already computes. Nothing new is stored to support a
check, for the reason docs/36 §1 gives: a metric with its own table can disagree
with the thing it measures.

| Check                   | Fires when                                               | Why it matters                                                                 |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `outbox.backlog`        | oldest unprocessed event older than `ALERT_OUTBOX_AGE_S` | The relay is behind. Sprint 22's throttle would have shown up here.            |
| `outbox.failing`        | events that have errored ≥ `ALERT_OUTBOX_FAILING`        | Deliveries are erroring, not merely queued.                                    |
| `scheduler.stale_claim` | any run `claimed` longer than the stale threshold        | docs/35 §5: the scheduler will never retry it. Somebody must force it by hand. |
| `scheduler.missed`      | a daily job with no successful run in `ALERT_JOB_AGE_H`  | Renewals or rank evaluation silently stopped happening.                        |
| `webhook.failing`       | endpoints with deliveries stuck failing                  | A tenant's integration is broken and only they can see it otherwise.           |

Every threshold is an environment variable with a default, and **every response
states the threshold it used next to the value it measured**. A firing alert
that does not say what line it crossed is a alert that gets muted.

## 3. Firing is not the same as telling someone

```
GET /platform/observability/alerts     what is firing right now, and when checks last ran
alert.sweep (scheduler job, 5 min)     evaluates, and EMAILS when something newly fires
```

The sweep is a scheduler job, so it inherits everything docs/35 already
guarantees: one run per occurrence, a row saying it happened, and a visible
`claimed` row if the process dies mid-sweep. Alerting that ran on its own timer
would be a second scheduler nobody could see.

**Notification is deliberately dumb**: one email to `AVIORA_ALERT_EMAIL`, which
is exactly one channel and no routing rules. Pagers, escalation policies and
on-call rotas are operational decisions, and inventing a routing engine before
anybody is on call would be ceremony.

### Not the same alert every five minutes

An `alert_states` row per check remembers what it last saw. An email goes out
when a check **starts** firing, and again when it **stops** — not on every
sweep. Re-sending every five minutes is how people build inbox rules that hide
the one that matters.

A check that keeps firing for `ALERT_REMINDER_HOURS` sends one reminder, because
a problem nobody fixed for a day should say so again. Once.

## 4. What this refuses

- **No thresholds that page on their own defaults.** The defaults are
  deliberately loose. An alert that fires on a normal Tuesday trains people to
  ignore alerting, which is worse than having none.
- **No alert on AI spend yet.** Cost is an estimate against a rate card
  (docs/36 §5), and paging somebody about an estimate is how you get an argument
  instead of an action. The number is on the dashboard; a budget alert belongs
  with real invoices.
- **No incident state, acknowledgement or silencing.** That is a product, and
  the ones that exist are better than one built here in an afternoon.
