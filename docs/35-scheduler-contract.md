# 35 — Scheduler Contract (Sprint 16)

> Closes the largest carried risk in `docs/33` §3: **nothing runs on a timer.**
> Subscription renewal, rank evaluation and commission runs are all endpoint-
> triggered, which means today the product only works while somebody is
> pressing buttons. That is the gap most likely to be discovered in production.

## 1. What a scheduler must not do

Three failure modes decide the design, and every rule below exists to prevent
one of them:

- **Running twice.** Two instances, or one instance restarted mid-run, must not
  bill a subscription twice. This is the same problem the commission run, the
  webhook and the automation engine already solved, and it gets the same
  answer: a row claimed with `FOR UPDATE SKIP LOCKED`, unique on the work it
  represents.
- **Running silently.** A job that quietly does not run is worse than one that
  fails loudly, because nobody looks for it. Every occurrence is recorded
  before it starts and settled after, so "did renewals run last night?" is a
  query, not a guess.
- **One tenant stopping the rest.** A tenant whose data makes a job throw must
  not prevent every other tenant's work. Isolation per tenant, recorded per
  tenant — the lesson the email handler taught in Sprint 3.

## 2. The shape

```
ScheduledJobRun  job · tenant_id (nullable) · scheduled_for · status
                 started_at · finished_at · outcome (JSON) · error · attempts
```

- `UNIQUE (job, tenant_id, scheduled_for)` — **one run per job, per tenant, per
  occurrence.** Restarting the process mid-run does not produce a second.
- `scheduled_for` is the occurrence, not the moment work began. A job that runs
  late still runs _for_ the slot it missed, and says so.
- Platform-wide jobs carry `tenant_id = NULL`; per-tenant jobs carry the tenant.

## 3. The jobs, and when they run

Occurrences are computed in **the tenant's timezone**, because "daily" means a
day where the tenant lives (docs/29 §2). A tenant in Bangkok renewing at 02:00
local must not renew at 09:00 local because the server thinks in UTC.

| Job                  | Cadence                                                    | What it calls                       | Why it is safe to repeat                               |
| -------------------- | ---------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `subscription.renew` | daily, tenant-local                                        | the existing `runDue`               | `subscription_runs` is unique per (subscription, date) |
| `rank.evaluate`      | daily, tenant-local                                        | the existing tenant-wide evaluate   | rank history only changes when the outcome does        |
| `commission.draft`   | monthly, tenant-local, on the 1st for the month just ended | creates a DRAFT run only            | runs are unique per (plan, period)                     |
| `webhook.sweep`      | every 5 minutes, platform                                  | nothing new — reports what is stuck | read-only                                              |

**`commission.draft` never approves.** Money leaves on a person's decision, not
a timer's. The job prepares the draft and stops; approval stays a deliberate
act by someone who looked at it.

Nothing here computes anything new. Every job calls the same service an
administrator's button already calls — a second implementation would be a
second answer.

## 4. Catch-up, and its limit

**Where catch-up starts.** From the last recorded occurrence of that job for
that tenant. If there is no prior run — a new tenant, or a job that has never
executed — it starts from **now**, and no history is backfilled. A tenant that
did not exist last week does not owe last week's renewals.

**How far it will go.** Occurrences within the last **3 days** are run, in
order. Anything older is recorded as `skipped` with the reason and is _not_
run, because a month of missed renewals firing at once is not recovery, it is
an incident. The skipped rows exist so the gap is visible: silence would let a
week of missed work look identical to a week with nothing to do.

To keep a long outage from writing an unbounded number of rows, at most **30**
skipped occurrences are recorded per job, per tenant, per tick; the last of
them says how many were elided. An operator can still run any occurrence by
hand through §5.

## 5. Operating it

| Method | Path                       | Permission    | Notes                                                                    |
| ------ | -------------------------- | ------------- | ------------------------------------------------------------------------ |
| `GET`  | `/platform/scheduler/runs` | platform role | What ran, when, and what happened.                                       |
| `POST` | `/platform/scheduler/run`  | platform role | Force one job/occurrence — the manual override an operator needs at 3am. |

The listing is the answer to "did it run", and it is platform-scope because the
schedule is the platform's machinery, not a tenant's.

Disabled in tests and in any process that sets `AVIORA_SCHEDULER_DISABLED`, the
same switch the outbox relay already honours, so tests drive it by hand.

**A run left `claimed` stays claimed.** If the process dies between claiming an
occurrence and settling it, no later tick picks that occurrence up: §1 chooses a
missed run over a second payment, and from the outside nothing can tell whether
the work finished before the process went. That occurrence is then a job that
did not run, and the only thing that runs it is an operator forcing it — which
is what `POST /platform/scheduler/run` is for.

So stale claims are the one thing an operator has to look for rather than be
told: `GET /platform/scheduler/runs?status=claimed` lists them, and a `claimed`
row whose `started_at` is not minutes old is a job nobody ran. No alert sits
behind this yet, so it is named here as the manual step it currently is.

## 6. What this refuses

- **No cron expressions per tenant.** A tenant cannot yet choose _when_ their
  renewals run. Offering that means offering a cron parser, per-tenant drift and
  support calls about a syntax nobody enjoys. Cadence is fixed; the timezone is
  theirs.
- **No distributed leader election.** The claim-a-row pattern is correct for one
  process and for several; a proper scheduler cluster is BullMQ's job, which
  docs/11 already names as the upgrade path.
- **No job that moves money without a person.**
