# 13 — Security Architecture

> **Project:** AVIORA — Multi-Tenant Membership, Healthy Living & Growth Operating System
> **Status:** Approved for MVP · **Last updated:** 2026-08-19
> **Spec references:** §58 (security), §59 (health data privacy), §60 (audit), §50 (AI knowledge security)
> **Stack:** NestJS 11 · Next.js 15 · PostgreSQL 17 + Prisma · Redis · Cloudflare R2

---

## 1. Threat Model Summary

The single highest-priority invariant (spec §69): **Tenant A must never access Tenant B data.**

| #   | Threat                                                                   | Impact                                  | Primary mitigations                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Cross-tenant data leak** (IDOR, missing filter, cache bleed)           | Catastrophic — platform trust destroyed | Defense-in-depth §4: RLS + Prisma auto-filter + guard asserts; tenant-isolation test suite in CI; tenant-prefixed cache keys & storage paths                                                                                                                                                                                         |
| 2   | Privilege escalation within tenant (member → admin, leader beyond scope) | High                                    | RBAC + scope guards on every route (§3); permission changes audited with before/after; no client-supplied role/tenant ids trusted                                                                                                                                                                                                    |
| 3   | Health data exposure to leaders/staff                                    | High — legal (PDPA) + trust             | Consent-grant gate over RBAC (§6); dedicated namespace; field encryption; full audit                                                                                                                                                                                                                                                 |
| 4   | Credential/secret leak (API keys, DB creds in repo/logs)                 | High — historical incident class        | Secrets management §7: no plaintext in repo, gitleaks pre-commit + CI mandatory, key restrictions, rotation runbook                                                                                                                                                                                                                  |
| 5   | Session/token theft (XSS, replay)                                        | High                                    | HttpOnly refresh cookies, 15-min access tokens, rotation + reuse detection, Redis revocation, CSP                                                                                                                                                                                                                                    |
| 6   | Injection (SQLi, NoSQLi, prompt injection into AI)                       | High                                    | Prisma parameterized queries only; zod/class-validator on every endpoint; AI retrieval authorization before retrieval; AI output treated as untrusted                                                                                                                                                                                |
| 7   | Abuse of expensive endpoints (AI, exports) → cost blowout                | Medium                                  | Rate limiting tiers + per-tenant AI token budgets + billing alerts                                                                                                                                                                                                                                                                   |
| 8   | Webhook forgery (payment, LINE)                                          | Medium                                  | HMAC signature verification before any processing (§9)                                                                                                                                                                                                                                                                               |
| 9   | Audit trail tampering / gaps                                             | Medium                                  | Append-only audit table, no UPDATE/DELETE grants, writes in same transaction as mutation                                                                                                                                                                                                                                             |
| 10  | Account takeover (credential stuffing, weak passwords)                   | Medium                                  | Argon2id ✓ · per-IP **and** per-account attempt limits with self-healing windows, refusals audited and alerted (docs/48) ✓ · breach-password denylist ✗ · MFA ✗. This row claimed the rate limits before they existed: until Sprint 29 `POST /auth/login` was limited by nothing, and answered sixty wrong passwords in two seconds. |

---

## 2. Authentication

### 2.1 Password storage

- **Argon2id** (`argon2` package): memory ≥ 64 MiB, iterations ≥ 3, parallelism 4; parameters stored per-hash so they can be raised over time (rehash-on-login).
- Password policy: min 10 chars, checked against a breached-password list; no forced rotation, no composition silliness.
- Verification is constant-time; login errors never distinguish "no such user" from "wrong password".

### 2.2 Tokens & sessions

| Artifact           | Properties                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access token**   | JWT (ES256), **15 min TTL**. Claims: `sub` (user id), `tid` (tenant id), `sid` (session id), `iat`, `exp`, `jti`. No roles/permissions embedded (fetched server-side, cacheable) |
| **Refresh token**  | Opaque 256-bit random, **rotated on every use**. Delivered only as cookie: `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`. Server stores only its SHA-256 hash              |
| **Session record** | Redis: `session:{sid}` → user, tenant, device, ip, refresh-hash, `created_at`, `last_used_at`. TTL = refresh lifetime (30 days sliding)                                          |

**Rotation & reuse detection:** each `POST /auth/refresh` invalidates the presented token
and issues a new one. Presenting an already-rotated token = theft signal → the whole
session family is revoked and the event is audited (`SessionReuseDetected`).

**Revocation:** logout deletes `session:{sid}`; the auth guard checks `sid` liveness in
Redis on every request (O(1)), so revocation takes effect within the current request —
no waiting out the 15-minute JWT window for revoked sessions.

### 2.3 Roadmap

| Phase   | Capability                                                                     |
| ------- | ------------------------------------------------------------------------------ |
| MVP     | Email + password (Argon2id), invitation-token registration, session revocation |
| Phase 2 | **MFA** (TOTP + recovery codes), **OAuth2/OIDC social login** (Google, LINE)   |
| Phase 4 | **Enterprise SSO** (SAML / OIDC per tenant), SCIM provisioning                 |

---

## 3. Authorization

Fixed evaluation order on every request (fail fast, fail closed):

```text
1. authn        — JWT valid, session alive (Redis)
2. tenant       — resolve tenant (subdomain / custom domain / X-Tenant-ID / tid claim),
                  verify active TenantMembership, set TenantContext + app.tenant_id
3. RBAC         — @RequirePermission('team.member.view') against cached permission set
4. scope        — SELF / DIRECT_TEAM / DESCENDANT_TEAMS / SPECIFIC_TEAMS / TENANT_ALL
                  resolved via team_closure
5. entitlement  — tenant plan includes the capability (e.g. ai.coach)
```

- Implemented as an ordered NestJS guard chain; controllers declare requirements via decorators, never inline checks.
- Permission sets cached in Redis per `(user_id, tenant_id)`, TTL 5 min, **evicted synchronously** on role/grant/leadership change.
- `user_id`, `tenant_id`, `member_id` come **only** from the verified token + server-side lookups — never from request body or query.
- Full matrix and health-data consent semantics: [07-role-permission-matrix.md](./07-role-permission-matrix.md).

---

## 4. Tenant Isolation — Defense in Depth

Three independent layers; any single layer failing must not produce a leak.

### Layer 1 — PostgreSQL Row-Level Security

```sql
ALTER TABLE member ENABLE ROW LEVEL SECURITY;
ALTER TABLE member FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON member
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

- Every tenant-owned table carries `tenant_id uuid NOT NULL` and the policy above.
- The app connects as a **non-superuser role that does not own the tables** (RLS is not bypassed).
- `app.tenant_id` is set per transaction: `SET LOCAL app.tenant_id = $1` inside the Prisma interactive transaction / `$extends` wrapper — `SET LOCAL` ensures no leakage across pooled connections.
- Platform-level jobs use a separate role with explicit, audited `BYPASSRLS`-free policies per table (no blanket bypass).

### Layer 2 — Prisma client extension (auto-filter)

- A Prisma `$extends` query extension injects `where: { tenant_id: ctx.tenantId }` into every query on tenant-owned models and stamps `tenant_id` on every create.
- `TenantContext` is carried by **nestjs-cls** (AsyncLocalStorage) — no passing tenant ids through method signatures, no ambient globals.
- Models without `tenant_id` (e.g., `user`, `tenant` itself) are on an explicit allow-list; adding a model to that list requires code review sign-off.

### Layer 3 — Guard asserts & fail-closed context

- The tenant guard **asserts** `TenantContext` is populated before any handler; a request with no resolved tenant on a tenant-scoped route → `403`, never "unfiltered query".
- Repository base class re-asserts `result.tenant_id === ctx.tenantId` on single-record reads in dev/test (canary; stripped in prod hot paths).
- **Beyond the DB:** Redis keys are prefixed `t:{tenant_id}:…`; R2 object paths are `/tenants/{tenant_id}/…` (member-private: `/tenants/{tenant_id}/members/{member_id}/…`) with signed URLs only; AI/RAG retrieval filters by tenant + scope **before** vector search (spec §50); analytics queries go through tenant-scoped views.
- CI runs the **tenant-isolation test suite** (two seeded tenants, every endpoint probed cross-tenant) — a red suite blocks merge.

---

## 5. Encryption

| Surface                    | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In transit                 | TLS 1.2+ everywhere (Cloudflare edge → origin included); HSTS `max-age=63072000; includeSubDomains`; no plaintext internal hops                                                                                                                                                                                                                                                                                                |
| At rest — DB               | Managed PostgreSQL 17 volume encryption (AES-256)                                                                                                                                                                                                                                                                                                                                                                              |
| At rest — objects          | Cloudflare R2 server-side encryption; bucket-level access via scoped API tokens only                                                                                                                                                                                                                                                                                                                                           |
| At rest — backups          | Encrypted snapshots; restore drills quarterly                                                                                                                                                                                                                                                                                                                                                                                  |
| **PII fields**             | Application-level **AES-256-GCM** field encryption, `enc.v1:<nonce>:<ct>:<tag>`, fail-closed. **Applied to:** health profile free text (`lifestyle_notes`) and the OIDC `client_secret`. **NOT applied to:** CRM lead and customer `name` / `email` / `phone`, which are stored in plaintext. There are no national-id or address columns anywhere — that part of this row described a schema that was never built. See §11.1. |
| Keys                       | Data-encryption keys live in the **secret manager** (never in DB or repo); `key_id` in the ciphertext envelope enables rotation (re-encrypt lazily on write). **Fail-closed:** if the key is unavailable, reads return an error — never plaintext fallbacks, never silently empty fields                                                                                                                                       |
| Search on encrypted fields | **Not implemented.** No blind index exists, and nothing currently needs one: no query filters or sorts on an encrypted column. It is named here because it is the thing that must arrive BEFORE any searchable field is encrypted, not after.                                                                                                                                                                                  |

---

## 6. Health-Data Privacy (spec §59)

- Dedicated permission namespace: `health.profile.view`, `health.profile.edit`, `health.coach.view` — excluded from wildcards and from all seeded roles beyond `SELF`.
- **Leaders, managers, admins and owners never see member health data via roles.** The only path is an explicit, revocable, expirable **`HealthDataGrant`** created by the member for a named grantee (full model in doc 07 §7).
- Guard logic: RBAC pass **AND** active consent grant — both required; failure returns `403 HEALTH_CONSENT_REQUIRED`.
- Health profile fields are AES-256-GCM encrypted (§5) and every read/write is audited.
- AI assistants may use a member's health context **only** for that member's own sessions or a consented coach; enforced at retrieval, not post-filtered.
- Team/tenant dashboards contain no health-derived metrics in MVP.

---

## 7. Secrets Management

- **No plaintext secrets in the repository — ever.** Only `.env.example` with placeholders is committed; `.env*` is gitignored with `!.env.example` negation.
- Runtime secrets come from the platform secret manager / encrypted environment store; local dev uses `.env.local` (gitignored).
- **gitleaks is mandatory**: pre-commit hook (blocks commit) **and** CI job (blocks merge), with `.gitleaks.toml` at repo root. `--no-verify` bypasses are prohibited without a written reason in the commit body.
- Every third-party API key is created **with application + API restrictions before first use**; server keys IP-restricted, browser keys referrer-restricted.
- Rotation: server-side keys, webhook signing secrets, and JWT signing keys rotate every 90 days (JWTs use `kid`-based key sets so rotation is seamless).
- If a secret ever touches git history: **rotate first**, restrict the new value, update the secret store, then (optionally) scrub history — in that order.

---

## 8. Rate Limiting & Input Validation

- Rate limiting tiers (auth / read / write / expensive / tenant-global) are defined in [10-api-design.md](./10-api-design.md) §8. **What is enforced today**: the public API by request (docs/30 §4, one shared budget in Redis since docs/38 §2), and the pre-auth surface by failed ATTEMPT — per IP and per account, counted in Redis with an in-memory fallback (docs/48). Read, write, expensive and tenant-global tiers are enforced as of docs/49, keyed by `(tenant, user)` with a separate ceiling on the tenant's own traffic — so an authorised member, a stolen session or a runaway script is bounded by rate and not only by permission.
- **Every endpoint validates input** with zod (shared schema package) or class-validator DTOs — no handler receives an unvalidated body, query, or param. Unknown fields are stripped (`whitelist: true`), type coercion is explicit, and validation failures return `400 VALIDATION_FAILED` with field-level `details`.
- File uploads: content-type sniffing (magic bytes, not extension), size caps, R2-only storage, never served from the app origin.
- Output encoding: React/Next.js default escaping; no `dangerouslySetInnerHTML` without sanitization (DOMPurify) and review.

---

## 9. Webhook Signature Verification

All inbound webhooks (payment provider, LINE, email events) follow one pattern —
**verify before touching business logic**:

```ts
// Nest controller — raw body preserved for this route
@Post('webhooks/payments')
handle(@Req() req: RawBodyRequest<Request>) {
  const signature = req.headers['x-signature'] as string;
  const expected = createHmac('sha256', config.webhook.paymentSecret)
    .update(req.rawBody)            // raw bytes, not re-serialized JSON
    .digest('hex');
  if (!signature || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new UnauthorizedException('invalid webhook signature'); // audited
  }
  // idempotent processing keyed by provider event id; enqueue, return 200 fast
}
```

Rules: raw-body HMAC with `timingSafeEqual`; reject on missing/invalid signature and audit
the attempt; process idempotently by provider event id; verify timestamp freshness
(±5 min) where the provider supplies one; webhook secrets rotate on the 90-day schedule.

---

## 10. Audit Logging (spec §60)

Append-only `audit_log` table (no UPDATE/DELETE privileges for the app role), written in
the **same transaction** as the mutation it records.

| Field                       | Notes                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`                        | uuid v7                                                                                                            |
| `tenant_id`                 | nullable only for platform-level actions                                                                           |
| `user_id`                   | acting authenticated user                                                                                          |
| `member_id`                 | acting/affected member where applicable                                                                            |
| `action`                    | verb key, e.g. `team.leader.assign`, `health.grant.revoke`                                                         |
| `entity_type` / `entity_id` | affected record                                                                                                    |
| `before` / `after`          | JSONB snapshots (diff-minimized; **encrypted-field values are redacted**, health values never stored in cleartext) |
| `occurred_at`               | timestamptz                                                                                                        |
| `ip`                        | client ip (from trusted proxy header chain)                                                                        |
| `device`                    | user-agent fingerprint summary                                                                                     |
| `request_id`                | correlates with logs/traces (doc 19)                                                                               |

**Sensitive actions that MUST be audited** (spec §60): membership create/assign/cancel;
team create/move/merge/archive; leader assignment changes; rank changes (Phase 3);
compensation & payment actions (Phase 3); **all health-data access, grants and
revocations**; role & permission changes; tenant configuration changes; auth events
(login failure bursts, session reuse, impersonation); data exports.

Retention: 2 years hot, then archived to R2 (encrypted, tenant-prefixed). Audit reads are
exposed via `GET /audit-logs` (permission `audit.view`) — and reading audit logs is itself
audited for export actions.

---

## 11. OWASP Top 10 Checklist (2021 mapping)

| #   | Risk                           | AVIORA control                                                                                                                                                                            |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Broken Access Control          | Guard chain (authn → tenant → RBAC → scope → entitlement) on every route; RLS backstop; cross-tenant test suite; deny-by-default routes                                                   |
| A02 | Cryptographic Failures         | TLS everywhere + HSTS; Argon2id; AES-256-GCM field encryption; no home-rolled crypto; keys in secret manager                                                                              |
| A03 | Injection                      | Prisma parameterized queries only (raw SQL requires review + params); zod/class-validator everywhere; output escaping; AI prompt/context separation                                       |
| A04 | Insecure Design                | Threat model (§1) maintained; consent-over-RBAC for health data; fail-closed defaults; idempotency on mutations                                                                           |
| A05 | Security Misconfiguration      | IaC-managed config; security headers (CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy); prod error responses leak nothing; default-deny CORS (known origins only) |
| A06 | Vulnerable Components          | `pnpm audit` + Renovate in CI; lockfile integrity; no postinstall from unreviewed packages                                                                                                |
| A07 | Identification & Auth Failures | Rate-limited auth, lockout backoff, breached-password check, session rotation + reuse detection, MFA (Phase 2)                                                                            |
| A08 | Software & Data Integrity      | Signed webhooks (§9); CI provenance; outbox events immutable; no dynamic code loading                                                                                                     |
| A09 | Logging & Monitoring Failures  | Structured logs + audit events + alerts (doc 19); auth anomaly alerts; request_id correlation end-to-end                                                                                  |
| A10 | SSRF                           | No user-supplied URL fetching in MVP; future fetchers use allow-listed hosts + metadata-IP blocklist + egress proxy                                                                       |

---

## Health data — the one place roles do not apply (as built)

Every other domain answers "may this role, at this scope, see this record?".
Health data answers a different question: **did this member share it?**

- `health.profile.view` / `health.profile.edit` are granted at `SELF` scope
  only. They let a member manage their own record; they never reach anyone else.
- `health.coach.view` lets a member _ask_ to read someone else's summary. The
  answer comes from `health_data_grants`, not from a role: a row created by the
  subject and not revoked. No grant, no access.
- Leadership confers nothing. A team leader with `DESCENDANT_TEAMS` on every
  other permission still gets 403 on a member's health data.
- **There is no admin override.** The tenant owner is refused like anyone else.
  An override would make the promise to members untrue, so it does not exist —
  if support ever needs it, it must be built as an explicit, audited, member-
  visible mechanism, never as a silent role check.
- A grant is **read-only and revocable**. Writing health data is always
  self-only; revoking closes access on the next request.
- Free-text health notes are encrypted at rest (AES-256-GCM, key from the
  environment). The encryption service **fails closed**: with no key configured
  it refuses to store rather than writing plaintext.
- Audit records _that_ health data changed and _who was granted access_, never
  the contents. `health.profile.update` stores a field count, not the text.

### Challenges that read health data

A habit-sourced challenge derives its progress from health records, which would
be an obvious way to leak them through a leaderboard. The boundary:

- **Joining is the consent.** A member appears on a leaderboard only because
  they joined; leaving removes them.
- **Only the derived count crosses.** The leaderboard carries a number and a
  display name — never a habit id, a log date, or a metric value.
- **Non-participants are absent, not zero.** A member who logs the same habit
  but never joined does not appear at all; a zero row would itself disclose
  that the platform holds their data.
- **A leaderboard is not an access grant.** A leader who can read the board
  still gets 403 on that member's health summary.
- The `HabitLogged` event that drives points and challenge progress carries a
  member id and a date only — no value, no habit name, no metric — so
  subscribers never receive health content.

Enforced by `apps/api/src/modules/health/health-access.service.ts`; proven by
`apps/api/test/e2e/health.e2e.spec.ts`, which asserts the leader, the tenant
owner and an unrelated member are all refused, that a grant opens read but not
write, and that revocation closes it immediately.

## 12. Residual Notes

- **Support impersonation** (platform Support role) requires tenant-admin consent flag, is time-boxed (≤ 1 h), banner-visible, and fully audited.
- **Data export** endpoints are permission-gated, rate-limited, watermarked with requester id, and audited.
- **PDPA**: member data subject requests (access/erasure) handled via tenant admin tooling; erasure preserves audit integrity by pseudonymization, not row deletion.

Related docs: [07-role-permission-matrix.md](./07-role-permission-matrix.md) · [10-api-design.md](./10-api-design.md) · [19-observability.md](./19-observability.md)

## 11.1 CRM contact data is not encrypted, and that is a decision to take

Found by auditing this document against the code: the PII row above claimed
field encryption for `phone`, and `crm_leads` / `crm_customers` store `name`,
`email` and `phone` in plaintext. A leaked CRM table is a leaked list of
prospects — real people who never signed up for anything.

It is **feasible** to encrypt them: nothing filters or sorts on those columns, so
no blind index is needed today. It has not been done, and the reasons are worth
writing down rather than deciding quietly:

1. **Encrypting existing production rows is a one-way door.** Lose the key and
   the CRM is gone — not degraded, gone. That is a decision for whoever owns the
   data and the key custody story, not a refactor.
2. **Encrypting `phone` alone would be close to theatre.** An attacker holding
   the row already has the name and the email; hiding one of the three changes
   little. If this is done it should be all three.
3. **It forecloses search.** Nothing searches leads by email today, but "find
   the lead with this email" is the most ordinary CRM request there is, and
   after encryption it needs the blind index this document has always promised
   and never had.

Until then: health data — the most sensitive thing here — IS encrypted, and the
CRM contact columns are plaintext behind row-level security, tenant scoping and
the ownership rules in `CrmScopeService`. That is the honest position, and this
section exists so nobody reads the table above and believes otherwise.
