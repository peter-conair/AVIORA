# 49 — The Tiers That Were Only Ever Written Down (Sprint 30)

> `docs/10 §8` defines five rate-limit tiers with exact defaults and says they
> are "enforced in middleware backed by Redis". Sprint 29 found that sentence
> was false for the pre-auth layer and fixed it. This is the rest of it:
> **read, write, expensive and tenant-global were enforced by nothing.**

## 1. What was actually protected

| Surface             | Before                                      |
| ------------------- | ------------------------------------------- |
| Public API (by key) | 120 req/min, one budget in Redis ✓          |
| `/auth/login` etc.  | per-IP and per-account attempts (docs/48) ✓ |
| **Everything else** | **nothing**                                 |

An authenticated member is bounded by permissions and entitlements — by _what_
they may do, never by _how often_. So an authorised person (or a stolen session,
or a well-meaning script) could call the assistant, an analytics window or a
compensation run in a loop, and the only thing that would notice is the bill.

The AI path has a per-member daily token quota, which caps the money but not the
load. Nothing else had either.

## 2. The tiers, as docs/10 §8 already specified them

Kept, rather than redesigned — a document that specified this correctly and was
never implemented deserves to be implemented, not rewritten:

| Tier            | Applies to                             | Default     | Key           |
| --------------- | -------------------------------------- | ----------- | ------------- |
| `read`          | every `GET`                            | 600 / min   | tenant + user |
| `write`         | every mutation                         | 120 / min   | tenant + user |
| `expensive`     | AI calls and whole-tenant computations | 20 / min    | tenant + user |
| `tenant-global` | the whole tenant                       | 5,000 / min | tenant        |

`auth` is Sprint 29's and is not repeated here.

**What counts as expensive: it costs money, or it scans the whole tenant.** An
AI call is money to a provider; a compensation run traverses everybody. An
analytics dashboard is neither — it is a handful of queries, and a leader
flipping between three windows and asking the coach eight questions is one
person using the product, not an attack.

The first version of this sprint put dashboards and AI calls in the same 20/min
budget, and the analytics suite failed nine times over: eight questions plus
three windows is eleven, and the eight questions are docs/28 §4's whole point.
The test was right and the tier was wrong. Dashboards are `read`.

**A route is `expensive` only by saying so.** `@RateTier('expensive')` on the
handler; everything else falls to `read` or `write` by HTTP method. A list of
expensive paths kept somewhere else would drift from the routes it names — the
failure this codebase has now met five times.

## 3. Where it runs, and why not earlier

As a guard, after authentication. That is later than a rate limiter usually
wants to be — the cheapest refusal happens before any work — but the tiers are
keyed by tenant and user, and neither exists until the token is verified.

The pre-auth layer is what stands in front of that, and it already exists: the
public API limiter by key, and docs/48's attempt limiter by IP. An unauthenticated
flood never reaches this guard.

## 4. Two things it must not do

**It must not lock a tenant out of its own platform.** `tenant-global` is 5,000
a minute — high enough that only a runaway reaches it, and it is a ceiling on
one tenant's own traffic rather than a shared pool, so one tenant cannot starve
another. A shared pool would make one customer's script another customer's
outage.

**It must not fail closed.** Redis unreachable falls back to the in-memory
counter, exactly as docs/38 §2 and docs/48 §4 do: a cache outage that logs
everyone out of the product is worse than one that degrades a limit to
per-process.

## 5. Headers

`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every response
that passes through a tier, and `Retry-After` on a 429 — the names docs/10 §8
specifies.

They differ from the public API's `X-RateLimit-*`, which shipped first and has
callers. That inconsistency is real, and it is left alone deliberately: renaming
a header that integrators already read, to satisfy a document, would break
somebody's code to make a table tidier. It is recorded in docs/10 §8 instead.

## 6. What this does not do

- **No per-plan limits.** docs/10 §8 says "configurable per tenant plan"; that
  is a limits table, a resolution order and an admin screen, for a need nobody
  has expressed. One number an operator can change is the honest default, and
  the tier lookup is where a plan-scaled limit would slot in later.
- **No token bucket.** A fixed window per minute, like every other limiter here.
  A bucket smooths bursts more kindly; having two algorithms in one codebase is
  a worse problem than a slightly blunt window.
- **No queueing or shedding.** A refused request is refused, not deferred.
