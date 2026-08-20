# 24 — Commerce & Subscription Contract (Sprint 8)

> Spec §39 (Commerce OS) and §40 (Subscription / Standing Order).
> Guiding line from the spec: **"Commerce supports the journey."** It is never
> the entry point, and a tenant that sells nothing simply never receives the
> `commerce.enabled` entitlement.

## 1. Shape of the domain

| Concept               | Why it exists                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Offering`            | What a **tenant sells**. Optionally points at a knowledge `Product`, which stays brand-neutral and may be global. |
| `OfferingPlanPrice`   | Membership pricing as **data**: a plan pays a different price. No code branches on a plan's name.                 |
| `Coupon`              | Percent or fixed discount, with validity window and redemption cap.                                               |
| `Cart` / `CartItem`   | One open cart per member. Item price is **snapshotted** when added.                                               |
| `Order` / `OrderItem` | Immutable record of a purchase; item name is snapshotted so a rename cannot rewrite history.                      |
| `Payment`             | Provider-agnostic. The only shipped provider is `manual` (recorded offline payment); a PSP is another value.      |
| `Subscription`        | Interval-agnostic recurring order: `intervalUnit` × `intervalCount`. Monthly, quarterly and custom are one path.  |
| `SubscriptionRun`     | One row per scheduled cycle, unique on `(subscriptionId, scheduledFor)` — what makes renewal safe to retry.       |

### Money

Integer **minor units** plus an ISO-4217 code on every priced row. No floats,
and no assumption that a tenant sells in one currency. A tenant's default comes
from the tenant setting `commerce.currency` (fallback `THB` only because the
seed tenant is Thai — nothing in code depends on it).

### Price resolution (single rule, used by cart and subscription alike)

```
price(offering, member) =
  OfferingPlanPrice for the member's ACTIVE membership plan, if one exists
  otherwise offering.priceMinor
```

## 2. Permissions and entitlement

| Key                            | Held by (system roles)    | Scope        |
| ------------------------------ | ------------------------- | ------------ |
| `commerce.catalog.view`        | MEMBER, LEADER, owner     | `TENANT_ALL` |
| `commerce.catalog.manage`      | owner                     | `TENANT_ALL` |
| `commerce.order.view`          | MEMBER (own), owner (all) | `SELF`       |
| `commerce.order.manage`        | owner                     | `TENANT_ALL` |
| `commerce.subscription.manage` | MEMBER (own), owner       | `SELF`       |

### Where the entitlement applies

Entitlements are resolved from a **member's active membership plan**, so they
can only gate what a member does. `commerce.enabled` is therefore enforced on
the **cart and checkout** — the act of buying — and nowhere else:

| Route group                       | Entitlement | Why                                                                                                                   |
| --------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `/cart/*` (incl. checkout)        | required    | Buying is the member capability the plan grants.                                                                      |
| `/offerings`, `/coupons` (admin)  | no          | A tenant owner holds no membership plan; gating this locks them out of their own shop.                                |
| `GET /orders`, `GET /orders/:id`  | no          | A member whose plan changes must still be able to read what they already bought.                                      |
| `/orders/:id/payments`, `/cancel` | no          | Administrator actions.                                                                                                |
| `/subscriptions/*` member actions | no          | Cancelling or pausing something you already pay for must not depend on still holding the entitlement that started it. |
| `POST /subscriptions/run-due`     | no          | The scheduler is not a member.                                                                                        |

A member without the entitlement can browse the catalogue and read their own
history; they cannot put anything in a cart.

## 3. Routes

All under `/api/v1`, all tenant-scoped, all returning the standard error envelope.

### Catalogue (admin)

| Method  | Path                        | Permission                | Notes                                  |
| ------- | --------------------------- | ------------------------- | -------------------------------------- |
| `GET`   | `/offerings`                | `commerce.catalog.view`   | Active offerings + the caller's price. |
| `POST`  | `/offerings`                | `commerce.catalog.manage` | `kind: one_time \| subscription`.      |
| `PATCH` | `/offerings/:id`            | `commerce.catalog.manage` | Name, price, status, interval.         |
| `PUT`   | `/offerings/:id/plan-price` | `commerce.catalog.manage` | Body `{ planId, priceMinor }`; upsert. |
| `POST`  | `/coupons`                  | `commerce.catalog.manage` |                                        |
| `GET`   | `/coupons`                  | `commerce.catalog.manage` |                                        |

### Cart and checkout (member)

| Method   | Path              | Permission              | Notes                                            |
| -------- | ----------------- | ----------------------- | ------------------------------------------------ |
| `GET`    | `/cart`           | `commerce.catalog.view` | Opens an empty cart on first call.               |
| `POST`   | `/cart/items`     | `commerce.catalog.view` | `{ offeringId, quantity }`; re-add updates qty.  |
| `DELETE` | `/cart/items/:id` | `commerce.catalog.view` |                                                  |
| `POST`   | `/cart/coupon`    | `commerce.catalog.view` | `{ code }`; validates window, cap, min subtotal. |
| `DELETE` | `/cart/coupon`    | `commerce.catalog.view` |                                                  |
| `POST`   | `/cart/checkout`  | `commerce.catalog.view` | Creates the order, closes the cart. Subscription |
|          |                   |                         | offerings also create the `Subscription`.        |

### Orders

| Method | Path                   | Permission              | Notes                                        |
| ------ | ---------------------- | ----------------------- | -------------------------------------------- |
| `GET`  | `/orders`              | `commerce.order.view`   | SELF scope returns only the caller's orders. |
| `GET`  | `/orders/:id`          | `commerce.order.view`   | 404 (not 403) for another member's order.    |
| `POST` | `/orders/:id/payments` | `commerce.order.manage` | `{ provider, amountMinor, providerRef? }`.   |
| `POST` | `/orders/:id/cancel`   | `commerce.order.manage` | Only while `pending`.                        |

A payment whose succeeded total reaches `totalMinor` flips the order to `paid`,
stamps `paidAt`, and emits `OrderCompleted`.

### Subscriptions

| Method | Path                        | Permission                     | Notes                                        |
| ------ | --------------------------- | ------------------------------ | -------------------------------------------- |
| `GET`  | `/subscriptions`            | `commerce.subscription.manage` | The caller's own.                            |
| `POST` | `/subscriptions/:id/pause`  | `commerce.subscription.manage` |                                              |
| `POST` | `/subscriptions/:id/resume` | `commerce.subscription.manage` | Next run moves to the next future date.      |
| `POST` | `/subscriptions/:id/skip`   | `commerce.subscription.manage` | Records a `skipped` run, advances one cycle. |
| `POST` | `/subscriptions/:id/cancel` | `commerce.subscription.manage` | Terminal.                                    |
| `POST` | `/subscriptions/run-due`    | `commerce.order.manage`        | Admin/scheduler tick; body `{ asOf? }`.      |

## 4. Renewal rules

- `run-due` selects `status = 'active' AND autoRenew AND nextRunOn <= asOf`.
- For each, it inserts a `SubscriptionRun` for `scheduledFor = nextRunOn`
  **first**. The unique key on `(subscriptionId, scheduledFor)` means a repeated
  tick — or two ticks racing — can never bill the same cycle twice.
- Then it creates a `pending` order for the subscription's price and quantity,
  advances `nextRunOn` by one interval, and emits `SubscriptionRenewed`.
- Paused subscriptions are skipped entirely; resuming moves `nextRunOn` forward
  to the next date at or after today, so a subscription paused for six months
  does not wake up owing six orders.

## 5. Events

`OrderPlaced`, `OrderCompleted`, `SubscriptionCreated`, `SubscriptionRenewed`,
`SubscriptionPaused`, `SubscriptionResumed`, `SubscriptionCancelled` — all
appended to the outbox inside the same transaction as the write they describe.

Gamification can reward `OrderCompleted` with no code change, because point
rules are tenant configuration.

## 6. What this sprint deliberately does not do

- **No payment provider.** Payments are recorded, not captured. Adding Stripe
  means one adapter behind the existing `provider` field, not a redesign.
- **No tax, shipping, or inventory.** They are real commerce concerns; none is
  needed to prove the recurring engine, and guessing a tax model for an
  unknown country would be worse than leaving the seam open.
- **No refund flow** beyond the `refunded` status value.
