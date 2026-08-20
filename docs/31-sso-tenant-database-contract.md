# 31 — Enterprise SSO & the Dedicated-Database Path (Sprint 15)

> Spec §77 (Enterprise & Scale), ADR-002's reserved migration path, docs/16 §5.
> This is the last Phase 4 sprint, and the one where the honest answer to part
> of the brief is "this cannot be finished here". That is written down rather
> than papered over.

## 1. SSO, and what a federated login may and may not do

```
TenantIdentityProvider  tenant_id · kind (oidc) · issuer · client_id
                        client_secret_hash · discovery_url · status
                        allowed_domains (String[]) · jit_provisioning (bool)
```

- **OIDC only.** SAML is a second protocol with its own signing, canonicalisation
  and metadata story, and shipping half of it would be worse than shipping none.
- The provider is **per tenant**. There is no platform-wide IdP, because there
  is no platform-wide organisation.
- `allowed_domains` bounds which email domains this provider may assert. A
  provider that can assert any address can assert the tenant owner's.
- **A federated login authenticates. It never authorises.** The IdP says who
  somebody is; the tenant's own roles say what they may do. Group or role
  claims are recorded on the membership for an administrator to look at and are
  _not_ mapped to permissions automatically — otherwise the identity provider
  becomes an unaudited path to permission grants.
- `jit_provisioning` may create a _member_ on first login, never a role beyond
  the tenant's default. A person who has never been invited arriving with a
  valid token is a member, not an administrator.

Flow: `GET /auth/sso/:tenantSlug/start` → redirect with state+PKCE →
`GET /auth/sso/callback` → verify id_token against the discovery document's
JWKS → resolve or provision the member → issue the platform's own session.
The platform's session remains the only thing the rest of the API trusts.

**State and nonce are single-use and expire.** A replayed callback is refused,
because an authorisation code that can be redeemed twice is an account that can
be taken over twice.

## 2. The dedicated-database path, and its limits

ADR-002 reserved this: every row is tenant-keyed and connections resolve
through one seam, so a large tenant's rows can move to their own database.
What this sprint delivers is the **seam and the rehearsal**, not a production
migration:

```
TenantDatabase  tenant_id · dsn_secret_ref · status (shared | migrating | dedicated)
                migrated_at · notes
```

- A resolver picks the connection for a tenant: shared by default, dedicated
  when a row says so and the DSN resolves. One place, so nothing else in the
  codebase learns that two databases exist.
- An **extract** command writes one tenant's rows, in dependency order, as a
  restorable dump, and a **verify** command compares row counts and checksums
  per table between source and target.
- `status = 'migrating'` makes the tenant **read-only** at the API edge. A
  migration that accepts writes it is about to discard is a migration that
  loses data.

**What is not claimed.** The roadmap's exit criterion — "one large tenant
migrated with zero data loss and bounded downtime" — cannot be honestly ticked
from a laptop. There is no large tenant, no second database host, and no
production traffic to bound downtime against. This sprint delivers the routing
seam, the extract/verify tooling and a written runbook; the criterion stays
**open** until it is rehearsed on staging with real volume. Marking it done
because the code exists would be the kind of claim that gets found out during
an incident.

## 3. Permissions

| Key                                 | Held by        | Scope        |
| ----------------------------------- | -------------- | ------------ |
| `tenant.sso.manage`                 | owner          | `TENANT_ALL` |
| `platform.tenant.manage` (existing) | platform roles | —            |

Database routing is platform work, not tenant work: a tenant cannot move
itself.

## 4. Routes

| Method   | Path                                  | Permission          | Notes                                     |
| -------- | ------------------------------------- | ------------------- | ----------------------------------------- |
| `GET`    | `/tenant/sso`                         | `tenant.sso.manage` | Never returns the client secret.          |
| `PUT`    | `/tenant/sso`                         | `tenant.sso.manage` | Upsert; secret write-only.                |
| `DELETE` | `/tenant/sso`                         | `tenant.sso.manage` | Federation off; local sign-in unaffected. |
| `GET`    | `/auth/sso/:tenantSlug/start`         | public              | Redirect to the IdP.                      |
| `GET`    | `/auth/sso/callback`                  | public              | Verify, provision, issue a session.       |
| `GET`    | `/platform/tenant-databases`          | platform role       | Where each tenant lives.                  |
| `POST`   | `/platform/tenant-databases/:id/plan` | platform role       | Dry run: what would move, and how much.   |

## 5. What this sprint refuses

- **No SAML.** Named, not silently missing.
- **No automatic permission mapping from IdP claims.** Recorded, surfaced,
  never applied.
- **No production migration.** The seam, the tooling and the runbook only.
- **No self-service tenant relocation.**
