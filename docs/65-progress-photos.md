# 65 · Before/after photographs, and consent

## 1. Why this needed its own decision

docs/64 §5 declined to build this in the middle of a programme sprint, on the
grounds that photographs of customers' bodies are the most sensitive thing this
product could hold and deserve their own privacy decision.

The answer, as it usually is, is **consent** — and this codebase already had the
shape for it. `HealthDataGrant` (docs/13, Sprint 6) is given, revocable, and
kept after revocation so the record of what was agreed survives the withdrawal
of it. `CustomerConsent` follows it, with one difference: a customer is not a
member and has no account to grant anything from, so **the member who took the
consent records it and is named**, along with how it was taken.

**Consent is per purpose.** Consent to be photographed is not consent to
anything else, and one blanket yes is how a consent model stops meaning
anything.

## 2. The two rules

Everything else here is detail. These two are the reason it is defensible:

### Nothing is stored without a **live** consent

Checked inside the upload transaction, on every upload. Not "was consented at
the time it started" — live. _They consented last month_ is not a fact about
now.

### Withdrawing consent **destroys** the photographs

Not hides. Not archives. `DELETE .../photo-consent` deletes every row and every
object, and returns how many went.

Hiding them would leave a customer's picture sitting in a bucket belonging to
somebody they have told to stop, which is not what withdrawing consent means to
the person withdrawing it.

The consent row itself is **kept**, closed with `revokedAt`. The photographs go;
the record of what was agreed and when it ended is exactly what somebody might
later need.

The storage deletes run **outside** the transaction. A failing bucket must not
roll back a withdrawal — the rows are already gone, so the objects are
unreachable either way, and an orphan in a bucket is a much smaller problem than
a consent that did not take.

## 3. The bytes never get a URL

`progress_photos.storage_key` never leaves the server. The list endpoint selects
around it explicitly, and a test asserts it is absent from the response.

A URL that works without passing through this API is a photograph with no access
control on it, and no amount of guessing at expiry times fixes that. Bytes come
back only from `GET /photos/:id/content`, behind the same CRM scope as every
other customer record, with `Cache-Control: private, no-store` so no proxy keeps
a copy nobody consented to.

There is deliberately **no `platform_access` policy** on either table. The
platform role reads across tenants for support (docs/53); a customer consented
to their salesperson holding their photograph, not to the platform operator
being able to look at it.

## 4. Storage as a port

`storage.port.ts`, the same shape as the AI gateway's `provider.port.ts`: one
interface, an adapter per backing store, and nothing above it knows which is in
use. Adding an R2 or S3 adapter is a file and a branch, not a rewrite of
everything that stores a photograph.

Today there is one adapter: files on the API container's own disk.

### 4.1 Which production refuses

Local disk is **not durable** — a container restart on most hosts loses
everything. `selectStorage` throws at startup when `NODE_ENV=production` or
`BACKEND_ENV=prod` and the chosen adapter says it is not durable.

Booting production on local disk would work perfectly, right up to the first
redeploy, at which point photographs a customer consented to give exactly once
are gone and nobody finds out until somebody asks for their before picture.
Failing at startup is by a wide margin the kinder failure.

It is extracted from the module factory purely so it can be tested. Left inline
it would be a safety control nobody had ever watched fire, and this codebase has
found enough of those to stop making them.

## 5. What is still needed to run this in production

A durable adapter — a bucket, a credential, and an implementation of three
methods. Until then the API refuses to start in production with photos enabled,
which is the intended state rather than an oversight.

Two decisions belong to the business and are not made here:

- **Retention.** Nothing expires a photograph today except a withdrawal. How
  long a before picture should live after a programme ends is a policy, not a
  default I should invent.
- **Export.** A customer asking for a copy of their own photographs has no route
  today. It is a small endpoint on top of what exists, and worth building the
  day the retention policy is decided, since the two answers travel together.
