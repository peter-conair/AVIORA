# 46 — Partner Portal Contract (Sprint 27)

> Spec §77 (Phase 4), the last of its list that was neither built nor declined
> for a reason. A partner is an organisation a tenant works with — a gym, a
> clinic, a retailer — that brings people in and needs to see how that is going.

## 1. A partner is a third kind of principal, and that is the whole risk

Everything in this platform authenticates as one of two things: a **platform
role** (across tenants) or a **member** (inside one). `PermissionsGuard` refuses
any tenant-scoped route to somebody who is not a member of that tenant, and the
isolation suite exists to keep it that way.

A partner is neither. Partner staff are not members: they must not appear in
member counts, must not receive member communications, and must not reach a
single route that returns member data. Introducing a principal that skips
`assertMember` is exactly the kind of change that turns a guard into a
suggestion, so the seam is deliberately narrow and stated here in full:

- A route is partner-facing **only** if it carries `@RequirePartner()`. There is
  no configuration, no role that grants it, and no other way in.
- On such a route the guard resolves the partner from **the token's user inside
  the current tenant**, and sets it in CLS. It never reads a partner id from the
  path, the query or the body — so there is no id for a caller to change.
- Every partner route scopes to that CLS value. A partner route that took an id
  from the request would be the hole, and no such route exists.
- Partner-facing routes live under `/partner/*` and return **no member
  identities at all** (§3).

`@RequirePartner()` and `@RequirePermissions()` are mutually exclusive. A route
that tried to be both would be a route whose principal depends on who called it,
and the guard refuses that combination at startup rather than at runtime.

## 2. Shape

```
Partner        tenant_id · code · name · contact_email · status
PartnerUser    tenant_id · partner_id · user_id            (a person at the partner)
PartnerReferral tenant_id · partner_id · member_id · invitation_id · joined_at
```

**Attribution is earned, never self-reported.** A partner invites somebody with
`POST /partner/invitations`; when that invitation is accepted, an outbox handler
records the referral — the same mechanism sponsorship uses for seats (docs/45
§2). There is no route by which a partner claims a member they did not bring,
because a partner's numbers are the basis of what they get paid.

## 3. What a partner may see

The same answer corporate wellness gives a sponsor, for the same reason: they
brought these people, they did not acquire them.

| They may see                          | They may never see                                |
| ------------------------------------- | ------------------------------------------------- |
| how many people they referred         | who any of them are — no name, no email, no id    |
| how many are still active             | anything from health, in any aggregate            |
| when their referrals joined, by month | another partner's numbers, or the tenant's totals |

A partner with **one** referral learns nothing about that person beyond a count
of one, which is what they already knew when they sent the invitation.

## 4. Routes

| Method   | Path                   | Principal        | Notes                                    |
| -------- | ---------------------- | ---------------- | ---------------------------------------- |
| `POST`   | `/partners`            | `partner.manage` | Tenant creates a partner.                |
| `GET`    | `/partners`            | `partner.manage` | Partners with referral counts.           |
| `POST`   | `/partners/:id/users`  | `partner.manage` | Grants a person portal access.           |
| `DELETE` | `/partners/users/:id`  | `partner.manage` | Revokes it.                              |
| `GET`    | `/partner/me`          | **partner**      | The partner's own profile.               |
| `GET`    | `/partner/performance` | **partner**      | Counts only, scoped by CLS (§1).         |
| `POST`   | `/partner/invitations` | **partner**      | Invites a customer; attribution follows. |

## 5. What this refuses

- **No partner payouts.** A gym that refers customers expects to be paid, and
  that is the natural next feature — but compensation entries are keyed to
  members, a partner is not one, and inventing a second money path for a
  principal that cannot currently be paid would be inventing a liability. What
  a partner is owed is computed from their numbers, by people, until there is a
  payout provider (docs/26 §9).
- **No partner-authored content.** A partner writing into a tenant's knowledge
  or community is a moderation problem before it is a feature.
- **No cross-tenant partners.** One partner record belongs to one tenant. The
  same gym working with two tenants is two records, because merging them would
  mean one login reading two tenants' numbers.
