# 44 — Multi-brand Marketplace Contract (Sprint 25)

> Spec §77 (Phase 4) lists **Multi-brand Marketplace**. §39 lists Marketplace as
> a Commerce OS capability, §12 uses `marketplace.access` as an example
> entitlement, and §31 sets the rule that governs the whole thing: knowledge and
> products are **brand-neutral**.
>
> docs/33 §2 had this as "Phase 4 product surface, none started". That was not a
> reasoned decline like the others in that table — it was a to-do wearing a
> decision's clothes. This builds it.

## 1. What "multi-brand" means here, and what it cannot mean

There are two readings, and only one is compatible with this platform.

**Across brands, inside a tenant.** A tenant sells offerings that link to
products, and products belong to brands (`brands` is already global-or-tenant
data). A membership club stocking three supplement brands wants one catalogue
its members can browse and filter by brand. That is what this builds.

**Across tenants** — one storefront listing every tenant's offerings — is
**refused**, and the reason is the whole platform: every table is tenant-owned,
row-level security is FORCEd on all of them, and the isolation suite exists to
prove one tenant cannot read another's rows. A cross-tenant storefront would be
a deliberate hole in that, needing its own publication model, its own consent,
its own settlement between tenants, and its own answer for what happens when a
tenant leaves. Building it as a query that reaches across tenants would undo the
one guarantee this platform actually makes.

If a platform-level storefront is ever wanted, it is a **new aggregate that
tenants publish INTO**, not a query that reaches across them — and that is a
product decision with a commercial model attached, not a feature.

## 2. Brand is a facet, never a ranking signal

Spec §31 and §33 are unambiguous: brand neutrality. So:

- The marketplace returns **brand facets** — every brand present in the
  browsable set, with a count — so a member can filter deliberately.
- Ordering **never** considers brand. The sort is by the offering's own
  attributes (name, price) and nothing else, and the response says so.
- A tenant cannot promote a brand by paying for position, because there is
  nowhere to put that. There is no `sponsored`, no `weight`, no `rank` field on
  a brand, and adding one later would be the moment brand neutrality stopped
  being true.

This matters more than it looks. A marketplace is exactly where a brand-neutral
platform quietly stops being one, and it happens through a field nobody argued
about.

## 3. What a member sees

`GET /marketplace` — the browsable catalogue, and the surface `marketplace.access`
gates:

```
{ offerings: [...], brands: [{ id, name, count }], sort, appliedFilters, note }
```

- Only offerings that are `active` and available in the tenant's country, the
  same rule the catalogue already applies (docs/29 §5). A marketplace that shows
  something unbuyable wastes people's time.
- `?brand=<id>` filters. `?q=` matches name and description.
- Membership pricing already resolved for the caller's plan, because a price a
  member cannot actually pay is a price that will start an argument at checkout.

**The entitlement gates browsing, not the catalogue.** A tenant without
`marketplace.access` still has a catalogue and still sells — `/marketplace`
simply answers `ENTITLEMENT_REQUIRED`. This is the same distinction docs/24 §2
settled for commerce: gating what a tenant configures would lock owners out of
their own shop.

## 4. Routes

| Method | Path                  | Gate                                           | Notes                          |
| ------ | --------------------- | ---------------------------------------------- | ------------------------------ |
| `GET`  | `/marketplace`        | `marketplace.access` + `commerce.catalog.view` | Browse, filter, facets.        |
| `GET`  | `/marketplace/brands` | same                                           | Facets alone, for a filter UI. |

Buying is unchanged: the cart and checkout that already exist take these
offerings, because a second purchase path would be a second set of pricing and
tax rules to disagree with the first.

## 5. What this sprint refuses

- **No cross-tenant storefront** (§1).
- **No sponsored placement, promoted brands, or paid position** (§2).
- **No seller onboarding or per-brand payouts.** Those belong to a Partner
  Portal, which is its own Phase 4 item and its own contract.
- **No reviews or ratings.** Spec §30 already parks community product experience
  for want of data, and a five-star average over three reviews is decoration.
