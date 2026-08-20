# 29 — White Label & Multi-Country Contract (Sprint 13)

> Spec §56 (White Label), §55 (Multi-Country), §54 (Multi-Language).
> Phase 4 opens with the two features that are pure configuration. If the
> platform has been built the way it claims, neither needs a branch.

## 1. Branding is presentation, and never a permission

```
TenantBranding  app_name · logo_url · colors (JSON) · font_family
                landing (JSON) · email_from_name · email_footer
                hidden_features (String[])
```

`hidden_features` hides navigation. **It is not access control.** A hidden
route still answers, and it must — the permission and entitlement guards are
what refuse. Anything else means a tenant could "secure" a feature by removing
a menu item, and the first person to type the URL finds it.

This is written here because it is the mistake this feature invites. Hiding is
for tidiness; refusing is for security. They live in different layers and a
reviewer must be able to tell which one they are reading.

Colors and fonts are applied as CSS custom properties on the tenant's pages.
No tenant CSS is executed — a stylesheet is code, and a tenant supplying code
that runs in another member's browser is the same class of problem as script
injection.

## 2. Country, currency, timezone, language

```
TenantLocalisation  country · default_locale · currency · timezone
                    address_format · supported_locales (String[])
```

- **Currency** already exists as `commerce.currency` and moves here as its
  home, with the setting kept working. One tenant, one currency, resolved in
  one place (`common/money/currency.ts`).
- **Timezone** is what a day _means_ to this tenant. Analytics windows,
  "calendar month", subscription renewal dates and challenge day-boundaries
  resolve in the tenant's zone. Storage stays UTC — the platform rule is store
  UTC, convert at the edge — but "this month" for a Bangkok tenant must not
  end at 07:00 local because the server thinks in UTC.
- **Language**: `default_locale` seeds a member's language; `supported_locales`
  bounds what the switcher offers. Content translations already exist
  (`translations` JSONB + `search_text`); this only decides which locales a
  tenant admits.

## 3. Legal documents are versioned, and acceptance is recorded

```
LegalDocument    kind (terms | privacy | refund | custom) · locale · version
                 body · published_at · country
LegalAcceptance  member_id · document_id · accepted_at · ip_hash
```

A tenant operating in two countries publishes two versions; a member accepts
the one that was current for them. `LegalAcceptance` records **which version**,
not merely that they agreed — "the member accepted the terms" is worthless
evidence if nobody can say which terms.

Documents are immutable once published: an edit is a new version. Rewriting
what somebody agreed to, after they agreed to it, is not an edit.

## 4. Tax is a rate, and says so

Sprint 8 left tax out on the grounds that guessing a tax model for an unknown
country is worse than leaving the seam open. That still holds. What this sprint
adds is deliberately small:

```
TaxRule  country · region (nullable) · rate_basis_points · inclusive · label
```

An order resolves **one** rule — the most specific match for the tenant's
country and the customer's region — and stores the rate, the label and the
resulting amount on the order. Nothing is recomputed later: an order carries
what it was charged.

What this is **not**: a tax engine. No nexus rules, no per-product categories,
no exemption certificates, no VAT registration validation, no reverse charge.
The response and the admin screen both say so, because a field labelled "tax"
that quietly gets it wrong is worse than one that says "single configured
rate".

## 5. Product availability by country

`Offering.available_countries` (empty = everywhere). Checkout refuses an
offering not available in the tenant's country, with the reason. A catalogue
that shows something unbuyable is a catalogue that wastes people's time.

## 6. Routes

| Method | Path                   | Permission                | Notes                                            |
| ------ | ---------------------- | ------------------------- | ------------------------------------------------ |
| `GET`  | `/tenant/branding`     | public (by host)          | What a browser needs to paint the tenant.        |
| `PUT`  | `/tenant/branding`     | `tenant.settings.manage`  |                                                  |
| `GET`  | `/tenant/localisation` | any member                | Country, currency, timezone, locales.            |
| `PUT`  | `/tenant/localisation` | `tenant.settings.manage`  |                                                  |
| `GET`  | `/legal/:kind`         | public                    | Current version for the caller's locale/country. |
| `POST` | `/legal/:kind/accept`  | any member                | Records the version accepted.                    |
| `GET`  | `/legal/documents`     | `tenant.settings.manage`  | Every version, including superseded.             |
| `POST` | `/legal/documents`     | `tenant.settings.manage`  | Publishes a new version.                         |
| `GET`  | `/tax/rules`           | `commerce.catalog.manage` |                                                  |
| `PUT`  | `/tax/rules`           | `commerce.catalog.manage` | Upsert by (country, region).                     |

## 7. What this sprint refuses

- **No tenant-supplied CSS or HTML.** Colors, fonts and copy are data; markup
  and stylesheets are code. A tenant that needs a bespoke landing page can have
  one built, not injected.
- **No per-country payment providers.** There is still no payment provider at
  all; adding a country dimension to something that does not exist would be
  ceremony.
- **No automatic tax filing, reporting or remittance.**
