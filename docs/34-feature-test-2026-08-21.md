# 34 — Feature test session, 2026-08-21

> A hands-on pass over the running system — not the automated suites, which
> already pass. The point of doing it by hand is to catch what a test written
> alongside the code cannot: things that are technically correct and still
> useless to the person reading them.
>
> Method: drive the real API and the real UI as three roles (member, tenant
> owner, and nobody at all), preferring the newest surfaces, which have had the
> least genuine use. Every claim below was observed, not inferred.

## Environment

Local dev — API `:3021`, web `:3020`, Postgres `:5439`, tenant **Wellness One**.
Accounts: `somchai@aviora.local` (member + leader), `nok@aviora.local` (owner).

## What was exercised, and what happened

### Member surface — pass

All 16 member pages return 200 and every endpoint behind them answers:
dashboard, health summary and habits, goals, learning, knowledge, community,
gamification, rewards, offerings, cart, orders, subscriptions, ranks, referrals,
compensation, analytics, notifications.

`/analytics/team` answered 200 for Somchai, which looked wrong until checked:
he holds both `MEMBER` and `LEADER` and leads Bangkok Region, so the scope is
correct. Worth recording that the first reading of a result can be wrong.

### White label — pass, including the rule that matters

- Branding saved: app name, logo, colours, font, landing copy, hidden features.
- A colour containing `<script>` was refused (`VALIDATION_FAILED`, naming the
  field) and **the stored branding was unchanged afterwards** — a refusal that
  half-writes is worse than one that fails.
- With `crm` in `hiddenFeatures`, `GET /crm/leads` still answered **200** and
  the branding response still carried its own note saying so. Hiding is
  navigation, not access control, and it behaves that way in the running app.

### Legal documents — pass

Published terms twice: versions 1 then 2. The public reader returns version 2
with its body. The member-facing page names the version being accepted, lists
what was accepted before, and an anonymous `POST /legal/terms/accept` is
refused `401`. The accept control is gated on being signed in.

### Tax and checkout — pass, arithmetic verified by hand

7% VAT configured for TH. Bought the ฿790 member-priced kit:

```
subtotal 79000 · discount 0 · tax 5530 (VAT 7%, 700bp) · total 84530
round(79000 × 700 / 10000) = 5530 ✓     79000 + 5530 = 84530 ✓
```

The response carries the "single configured rate, not a tax engine" disclosure.

### Public API and keys — pass

A key minted with three scopes: shown once, absent from the listing, works on
`/public/members` and `/public/ranks`, refused `403` on `/public/orders` (a
scope it did not hold), `401` with no key, and `401` immediately after revoke.
Rate-limit headers present on every response including the refusals.

### Webhooks in the running app — pass, with one defect (fixed)

Completing a goal produced a delivery row, attempted against an unreachable
host, with attempts counting up and backoff scheduling — the outbox → relay →
dispatcher chain works outside the test harness.

**Defect found and fixed:** the recorded error read `fetch failed`. That is
exactly the "it didn't work" that docs/30 §1 says is not a support answer —
`fetch` reports every transport failure with the same three words and hides the
reason in `cause`, so DNS failures, refused connections and TLS mismatches all
looked identical. The cause chain is now unwrapped:

```
before: fetch failed
after:  fetch failed — ENOTFOUND: getaddrinfo ENOTFOUND webhook.invalid.localdomain
```

Three unit tests cover it, including a self-referential cause (which would
otherwise loop for ever) and a non-Error throw.

### SSO — pass on every refusal

No UI exists for this yet, so it was driven through the API: a plaintext
discovery URL is refused; `kind: "saml"` is refused **naming saml**; starting a
flow with no provider configured answers `400` with `step: "configuration"`;
a member without `tenant.sso.manage` gets `403`.

### Admin UI — pass

All 14 tabs render with content, no error text, no `undefined`/`NaN`, and **no
horizontal overflow at 375 px**: plans, invitations, teams, members,
gamification, commerce, ranks & referrals, compensation, automation & rewards,
analytics, integrations, branding & country, legal, audit.

### Branded manifest — pass

`GET /manifest.webmanifest` with the tenant's host returns `name: "Wellness
One"` and `theme_color: #0f766e` from their branding.

## Open observations (not fixed)

1. **A tenant reached without their own domain shows the platform's brand.**
   The public legal page rendered the wordmark "AVIORA" rather than "Wellness
   One", because tenant resolution by host cannot work on `localhost`. In
   production with a custom domain it resolves; on a shared or path-based URL it
   will not. Worth deciding deliberately: either accept it, or resolve the
   tenant from the path on public pages too.
2. **The API-key scope picker still cannot pre-filter.** `/auth/me` now returns
   the caller's permissions, but the integrations screen was written before that
   existed and still recovers from the server's refusal instead. Cosmetic, and
   a small follow-up.
3. **The `.next` corruption trap.** Two dev servers writing one `.next` leaves
   `prerender-manifest.json` malformed and every page 500s with a JSON syntax
   error that names no file. Not a product defect; it cost time twice, so it is
   written down.

## Verdict

Nothing found that would block using the product. One real defect — an error
message that could not be acted on — found only by running the thing rather
than reading it, which is the argument for doing this by hand.
