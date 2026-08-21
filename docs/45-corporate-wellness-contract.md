# 45 — Corporate Wellness Contract (Sprint 26)

> Spec §5 lists **Corporate Wellness** as a tenant type; §77 lists it as a
> Phase 4 surface. `tenants.tenant_type` already exists, so the label is not the
> work. The work is the one thing a corporate wellness organisation needs that
> no other tenant type does — and the collision it causes with §59.

## 1. The collision, stated first

An employer buys memberships for its employees. Having paid, it wants to know
whether the investment is working. The obvious answer — how are our people
doing? — is **exactly the data this platform refuses to share**:

- Health data is SELF-scoped with no admin override (docs/13).
- Health activity is excluded from every shared analytics surface, and does not
  even count as _activity_, because a member who only logs health would
  otherwise be identifiable as such (docs/28 §3).

Those rules do not get an exception for the party paying. A sponsor is not a
member's doctor, employer-provided or otherwise, and "we paid for it" is not
consent. So this sprint's answer to "is it working?" is **participation, never
health**, and every response says so in those words rather than leaving the
sponsor to discover the gap and ask for it as a feature.

What a sponsor may see about the people they sponsor:

| They may see                                   | They may never see                                |
| ---------------------------------------------- | ------------------------------------------------- |
| how many seats are used                        | who logged a habit, or that anyone did            |
| how many sponsored members are active          | any metric, weight, sleep or symptom              |
| learning completed, goals met, community posts | anything from `modules/health`, aggregated or not |

The second column is not a limitation to be relaxed later. It is the product.

## 2. Seats, and why they are reserved at invitation

```
SponsorshipPool  tenant_id · code · name · plan_id · seats · sponsor_name · status
SponsoredSeat    tenant_id · pool_id · member_id? · invitation_id? · assigned_at · released_at
```

A pool is "this sponsor has paid for N memberships on this plan". A seat is one
of them, and it is taken **when the invitation is sent**, not when it is
accepted.

That choice costs something — an invitation nobody accepts holds a seat until it
expires — and it is still the right one. Assigning only on acceptance lets an
employer with 100 seats invite 200 people, and the hundred who arrive second are
turned away at the door by a platform that told their employer everything was
fine. A seat held by an unaccepted invitation is a number the sponsor can see
and manage; a person refused after being invited is an apology.

Seats are released when an invitation expires or is revoked, and when a
sponsored membership ends.

**A member holds at most one active seat.** Enforced by a partial unique index
rather than by the service that happens to check, because two sponsors paying
for one person is a billing argument nobody can settle after the fact.

## 3. Routes

| Method   | Path                              | Permission           | Notes                                            |
| -------- | --------------------------------- | -------------------- | ------------------------------------------------ |
| `POST`   | `/sponsorships`                   | `sponsorship.manage` | Create a pool: plan, seats, sponsor name.        |
| `GET`    | `/sponsorships`                   | `sponsorship.manage` | Pools with seats used, reserved and free.        |
| `PATCH`  | `/sponsorships/:id`               | `sponsorship.manage` | Resize or close. Never below seats in use.       |
| `POST`   | `/sponsorships/:id/invitations`   | `sponsorship.manage` | Invites an employee and reserves a seat.         |
| `DELETE` | `/sponsorships/seats/:id`         | `sponsorship.manage` | Releases one seat.                               |
| `GET`    | `/sponsorships/:id/participation` | `sponsorship.manage` | Participation. States what it excludes, and why. |

Accepting a sponsored invitation is the **existing** invitation flow. A second
acceptance path would be a second place membership is created, and the two would
disagree about what a new member gets.

## 4. What this refuses

- **No per-employee reporting of any kind.** Not "who has not started", not
  "least active". A named list of people who did not use the benefit is a
  performance-management tool wearing a wellness badge, and it is the single
  most requested feature this contract will not add.
- **No billing integration.** A pool records what was paid for, not a payment;
  moving money still needs a provider that does not exist (docs/24).
- **No employer-side SSO shortcut.** Sponsored members authenticate like every
  other member. Enterprise SSO exists (docs/30) and a tenant may use it, but
  sponsorship does not imply an identity relationship.
