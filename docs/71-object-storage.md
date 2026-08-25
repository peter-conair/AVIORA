# 71 — Object Storage: MinIO Now, R2 Later

> **AVIORA** — the durable adapter production was waiting for, why it is written
> against S3 rather than against Cloudflare R2, and what moving to R2 costs.
>
> Status: implemented, verified against a real bucket · Last updated: 2026-08-23 ·
> Closes docs/65 §5 · Unblocks docs/70 §6

---

## 1. What was blocking production

docs/65 §4.1 has the API refuse to start in production on a non-durable store,
and until now `LocalDiskAdapter` was the only adapter there was. The refusal
worked exactly as designed, which meant **`NODE_ENV=production` could not boot at
all**. `AVIORA_R2_*` had been in `.env.example` since Sprint 0 and was read by
nothing.

That is now a durable adapter and a bucket, and the stack boots in production
mode. `pnpm smoke:images` asserts both — that the api is running as
`production`, and that it logged reaching a durable bucket. Asserting the log
line rather than "it started" is deliberate: a stack will also start on local
disk if somebody quietly lowers `NODE_ENV` to make a red check go green.

## 2. One adapter, three stores

`s3.adapter.ts` speaks S3. MinIO, Cloudflare R2 and AWS S3 all answer that same
API, so which one is behind it is four environment variables and never a line of
code:

| Variable                      | MinIO (today)          | R2 (later)                        |
| ----------------------------- | ---------------------- | --------------------------------- |
| `AVIORA_S3_ENDPOINT`          | `http://storage:9000`  | _unset_                           |
| `AVIORA_R2_ACCOUNT_ID`        | _unset_                | the account id — endpoint derived |
| `AVIORA_S3_BUCKET`            | `aviora`               | `aviora`                          |
| `AVIORA_S3_ACCESS_KEY_ID`     | MinIO root user        | R2 token id                       |
| `AVIORA_S3_SECRET_ACCESS_KEY` | MinIO root password    | R2 token secret                   |
| `AVIORA_S3_REGION`            | `auto`                 | `auto` — R2 has exactly one       |
| `AVIORA_S3_FORCE_PATH_STYLE`  | `true` (no bucket DNS) | `true` (works either way)         |

Writing this against R2 directly would have been the same amount of code and one
fewer place to test it. Writing it against S3 means the adapter is exercised on
a laptop, in CI, and in the image smoke — before it ever meets a real credential.

Three decisions inside it are worth keeping:

- **A partial configuration throws.** The tempting alternative is to treat
  incomplete settings as "not configured" and fall back to local disk. Then a
  typo in a bucket name is silent data loss outside production, and inside it a
  refusal that talks about durability and never mentions the typo — somebody
  would go looking for a missing adapter that was in fact right there.
- **A missing object is `null`, not an exception.** The caller turns it into a 404. An adapter that threw would make every missing photograph a 500, and
  would flatten a real fault into "no photo here", which reads to a customer as
  a deleted picture.
- **No signed URLs.** Bytes are read through the API, which is where the consent
  check lives. A URL that works without passing through this codebase is a
  photograph with no access control on it, and a short expiry does not change
  what it is.

## 3. Why MinIO first

R2 is the destination. It is not the starting point because the first tenants'
photographs need somewhere durable **today**, and R2 needs an account, a token
with restrictions applied before first use, and a bucket policy — none of which
should be rushed the week of a first deploy.

MinIO runs as a container on the same host, in the same compose file, with no
published ports. It is durable in the sense that matters here: the bytes survive
a redeploy, because they live on a named volume (`aviora_objects`) rather than
in a container layer. Versioning is enabled on the bucket the day it is created,
which is the only day it can be enabled without copying everything.

What MinIO on a shared VPS does **not** give you, and R2 does:

- Storage that is not on the same disk as the database it would fill up.
- Replication, so a host failure is not a photograph failure.
- Somebody else's operations team.

That list is the actual argument for moving, and none of it is urgent while the
tenant count is small and the bucket is measured in gigabytes.

## 4. Proving it

`test/integration/storage-s3.spec.ts` runs against a real bucket — MinIO locally
via `docker compose up minio minio-init`, MinIO in CI as a step in the
integration job. It skips when no bucket is configured, which is why CI
configures one: a suite that passes by never running is a failure this
repository has found more than once.

It checks the parts a mock has no opinion about: that the bytes returned are the
bytes stored, that the content type travels with them (the download endpoint
hands it straight to a browser), that a missing key answers `null`, that a
second delete still succeeds — consent withdrawal depends on that — and that
`verify()` genuinely fails against a bucket that does not exist. A startup check
that passes against a missing bucket is not a check.

`verify()` runs at boot, from `StorageModule.onApplicationBootstrap`. Production
refuses to serve when it fails; elsewhere it warns, because a developer whose
MinIO container is down should get a message rather than an API that will not
start. Without it, the first sign of a wrong key is a customer's upload failing
— after they have undressed and taken the photograph.

## 5. Moving to R2

### 5.1 When

Any one of these is the signal; none of them is a date:

- Object storage passes ~50 GB, or the host disk drops under 30% free.
- A second API host appears — two hosts cannot share a MinIO volume.
- A tenant contract requires geographic replication or a stated durability
  figure that a single VPS volume cannot honestly claim.

### 5.2 What it costs

R2 charges roughly **$0.015 per GB-month** with **no egress fee**, plus per-
operation charges that round to nothing at this scale. A progress photo is
capped at 4 MB (`MAX_PHOTO_BYTES`), so 10,000 photographs is ~40 GB — about
**$0.60 a month**. The reason to move is not the bill; the reason is the three
bullets at the end of §3.

### 5.3 How

The application does not change. Nothing below is a code change.

1. Create the bucket in the R2 dashboard. Enable versioning. **Do not make it
   public** — a public bucket makes every consent check in `photos.service.ts`
   decorative.
2. Create an API token scoped to **that one bucket**, Object Read & Write.
   Restrict it before it is used anywhere; an app-level quota does not protect a
   leaked token, and a token restriction does.
3. Copy the objects while the old store is still serving:
   ```bash
   mc alias set minio http://storage:9000 "$OLD_KEY" "$OLD_SECRET"
   mc alias set r2 "https://$ACCOUNT.r2.cloudflarestorage.com" "$NEW_KEY" "$NEW_SECRET"
   mc mirror --preserve minio/aviora r2/aviora
   ```
4. Verify by count and by sample, not by "it finished":
   ```bash
   mc ls --recursive minio/aviora | wc -l
   mc ls --recursive r2/aviora    | wc -l
   mc cat r2/aviora/<a-known-key> | sha256sum   # against the same key on minio
   ```
5. Swap the four variables: unset `AVIORA_S3_ENDPOINT`, set
   `AVIORA_R2_ACCOUNT_ID` and the new key pair. Restart the api. The boot check
   proves the new bucket is reachable before traffic arrives.
6. Run `mc mirror` **once more** to catch anything written during the swap, then
   spot-check a photograph through the API rather than through the bucket.
7. Keep MinIO running and untouched for a retention window. Only after a
   deliberate decision — and never as part of the same change — remove the
   volume. `aviora_objects` holds pictures that cannot be re-taken.

### 5.4 What does not move

Keys keep their shape: `tenants/{tenant_id}/customers/{customer_id}/{id}`
(docs/18 §2). That convention is why a mirror is a mirror and not a migration —
nothing needs rewriting, re-keying, or a database change. The `storage_key`
column keeps pointing at exactly the same string.

## 6. Still open

- **Retention.** Nothing expires a photograph except a withdrawal. How long a
  before picture should live after a programme ends is a policy decision, and
  docs/65 §5 was right to leave it to the business rather than invent a default.
  It becomes an R2 lifecycle rule, or a MinIO ILM rule, on the day it is decided.
- **Export.** A customer asking for a copy of their own photographs still has no
  route. It is a small endpoint on top of what now exists, and it travels with
  the retention answer.
- **Backup of the bucket.** docs/18 §5 asks for versioning plus scheduled
  cross-bucket replication. Versioning is on. Replication is a second bucket and
  a scheduled `mc mirror`, and it should exist before the first tenant with real
  customers — a volume on one host is a single point of failure for data that
  cannot be reconstructed from anything else.
