# 30 — Public API & Webhooks Contract (Sprint 14)

> Spec §77 (Enterprise & Scale) — the API Marketplace item; docs/16 §5.
> Also the white-label mobile base (spec §56), which is one manifest.

## 1. The outbox is already the event source

Webhooks are not a second event system. `domain_events` already records every
state change with an id, and the relay already retries with backoff. A webhook
is **one more handler** on that relay, exactly as automation was: it reads the
tenant's subscriptions and posts to them.

```
WebhookEndpoint   url · secret · events (String[]) · status · description
WebhookDelivery   endpoint_id · event_id · status · attempts · response_code
                  error · next_attempt_at · delivered_at
```

- `UNIQUE (endpoint_id, event_id)` — **an event is delivered to an endpoint at
  most once**, the same defence used by commission runs, subscription renewals
  and automation. A replayed event does not re-notify.
- Retries: 5 attempts with exponential backoff, then `failed` and it stays in
  the log. Silence is not an outcome anybody can debug.
- A delivery records the response code and the error text. "It didn't work" is
  not a support answer.

## 2. Signing, so the receiver can trust it

Every request carries:

```
X-Aviora-Event: <event name>
X-Aviora-Delivery: <delivery id>
X-Aviora-Timestamp: <unix seconds>
X-Aviora-Signature: sha256=<hex HMAC of "timestamp.body" with the endpoint secret>
```

The timestamp is inside the signed payload so a captured request cannot be
replayed later against a receiver that checks it.

The secret is shown **once** at creation and returned by no route afterwards.
Storing it is the interesting part, and the first draft of this contract asked
for something impossible: it said store a _hash_ and sign with the _secret_,
which cannot both be true of the same bytes, because HMAC needs the key back.

What actually happens: the database stores only `sha256(secret)`, and the
secret is **derived** at send time as
`HMAC(rootKey, "aviora.webhook.secret.v1:" + endpointId)`, verified against the
stored hash before use. So a stolen database dump yields no secret — which is
the property worth protecting — while the signature is computed with the real
one. Be precise about what this does not claim: the platform _can_ recompute
any secret, because it holds the root key. The guarantee is against a dump and
against a route that hands it back, not against the platform itself.

`AVIORA_WEBHOOK_SIGNING_KEY` must be set in production and must not be rotated
casually: rotating it invalidates every signature every receiver is verifying.

Bodies carry the event envelope and nothing more: id, name, tenant, aggregate,
payload, occurred-at. **No health data is ever in a webhook payload**, for the
same reason it is absent from analytics (docs/28 §2) — a subscription is not a
consent, and the tenant's own server is still another person.

## 3. API keys are scoped, and never wildcards

```
ApiKey  name · prefix · hash · scopes (String[]) · last_used_at · expires_at · revoked_at
```

- The key is shown **once**. Only a hash is stored, with a short prefix kept in
  clear so a person can tell two keys apart in a list.
- `scopes` are permission keys the platform already has. A key can never hold a
  scope its creator lacks — otherwise an admin mints themselves a promotion.
- A key is bound to one tenant. There is no cross-tenant key, because there is
  no cross-tenant caller.
- Revoking is immediate and permanent; `last_used_at` tells an operator whether
  a key is still in traffic before they pull it.

Authentication is `Authorization: Bearer <key>` on `/api/public/*`. The public
surface is read-mostly and deliberately narrow: members, teams, orders, ranks.
It grows when somebody asks, not in anticipation.

## 4. Rate limits, stated in the response

Every public response carries `X-RateLimit-Limit`, `-Remaining` and `-Reset`.
A limit a caller cannot see is a limit they will hit blind. Exceeding it is
`429` with `retry_after` in the body, never a silent drop.

## 5. The white-label manifest

`GET /manifest.webmanifest` (web) resolves the tenant by host and returns their
name, colours and icon, so an installed PWA carries the tenant's identity and
not ours. That is the honest extent of "white-label mobile" this sprint claims:
a branded installable web app. Native store distribution is a build pipeline
and an account per tenant, and pretending otherwise would be a lie in a roadmap.

## 6. Routes

| Method   | Path                             | Permission           | Notes                                  |
| -------- | -------------------------------- | -------------------- | -------------------------------------- |
| `GET`    | `/webhooks/endpoints`            | `integration.manage` | Never returns a secret.                |
| `POST`   | `/webhooks/endpoints`            | `integration.manage` | Returns the secret ONCE.               |
| `PATCH`  | `/webhooks/endpoints/:id`        | `integration.manage` | Events, status, description.           |
| `DELETE` | `/webhooks/endpoints/:id`        | `integration.manage` |                                        |
| `GET`    | `/webhooks/deliveries`           | `integration.manage` | Newest first, with response and error. |
| `POST`   | `/webhooks/deliveries/:id/retry` | `integration.manage` | Manual retry of a failed delivery.     |
| `GET`    | `/api-keys`                      | `integration.manage` | Prefixes only.                         |
| `POST`   | `/api-keys`                      | `integration.manage` | Returns the key ONCE.                  |
| `DELETE` | `/api-keys/:id`                  | `integration.manage` | Revokes.                               |
| `GET`    | `/public/members`                | key scope            | Public API, paginated.                 |
| `GET`    | `/public/orders`                 | key scope            |                                        |
| `GET`    | `/public/ranks`                  | key scope            |                                        |

## 7. What this sprint refuses

- **No health endpoints on the public API, and no health in webhook payloads.**
  Not by omission — by rule, stated here so nobody adds one later thinking it
  was an oversight.
- **No secret retrieval.** Lost secret means a new endpoint.
- **No wildcard scopes**, no `*`, no "all events" shortcut that silently grows
  when a new event is added. A subscription lists what it wants.
