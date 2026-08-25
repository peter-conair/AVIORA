# 74 · Products from another system

## 1. What this is

A second system holds a product catalogue. AVIORA holds a knowledge graph. This
is the one route between them:

```
POST /api/v1/public/knowledge/products
Authorization: Bearer avpk_…
Idempotency-Key: <optional>
```

```json
{
  "source": "onebidconnect",
  "products": [
    {
      "code": "hanna-hi98103",
      "name": "เครื่องวัดค่า pH แบบพกพา (Pocket pH Meter) HANNA รุ่น HI98103",
      "brand": { "code": "hanna", "name": "HANNA" },
      "description": "หนึ่งถึงสองประโยค — การ์ดแสดงบรรทัดนี้",
      "sourceUrl": "https://example.com/hi98103",
      "translations": { "en": { "name": "Pocket pH Meter HI98103" } },
      "ingredients": ["magnesium"],
      "status": "active"
    }
  ]
}
```

It answers 200 with a verdict per product, never 201 with a list of ids: a batch
in which some rows are refused is neither created nor failed, and the sender's
next question is always _which ones_.

```json
{
  "source": "onebidconnect",
  "created": 1,
  "updated": 0,
  "unchanged": 0,
  "refused": 1,
  "replayed": false,
  "results": [
    { "code": "hanna-hi98103", "outcome": "created", "ingredientsLinked": 1 },
    {
      "code": "verda-calm-blend",
      "outcome": "refused",
      "reason": "This code is curated in AVIORA and is not written by an ingest"
    }
  ]
}
```

## 2. Why the key belongs to no tenant

The knowledge catalogue is global — `tenant_id NULL`, read by every tenant. The
layered RLS policy on those tables lets every tenant READ global rows and write
only within its own, deliberately, so that no tenant can edit what all of them
read.

An ingest that wrote the shared catalogue with a tenant's key would be that
tenant editing everybody's data. So it takes a **platform key**: `avpk_…`,
minted at `POST /api/v1/platform/api-keys` by a platform role, stored in its own
table with no RLS policy and no grant to the app role.

`@RequirePlatformKey()` enforces the distinction in **both** directions. A
platform key cannot reach a route written for one tenant — it names no tenant,
and being handed whichever one the host resolved is exactly the bug. A tenant
key cannot reach this one.

The kind is checked _after_ the key is proven valid, so a caller holding no
valid key learns nothing about which table a prefix lives in.

## 3. Who owns a row

Every product records the system that wrote it. `NULL` means curated here — by
the seed, or by hand.

An ingest names itself in `source`, and a row whose source is not its own is
**refused and reported**, never rewritten. Two writers taking turns on one code
reads as working right up until the day a hand-written safety note disappears on
the next sync.

Refusing is per product, in its own transaction. A batch of a hundred with one
bad row writes the other ninety-nine.

## 4. Retrying

The write is already idempotent by its natural key: the same code twice is one
product. `Idempotency-Key` adds that the **answer** is idempotent too — a caller
whose connection dropped after the write retries and learns what the first
attempt did, instead of reading `unchanged` for work it does not know it
performed.

- No header: no record, the work simply runs. A scheduled hourly sync is two
  deliberate identical requests, and hashing the body would collapse them.
- Same key, same body: the first answer is replayed, `replayed: true`.
- Same key, **different** body: 409. That is a sender reusing a key across two
  batches, and replaying the first would report the second as written.
- Records expire after 24 hours.

## 5. The part that decides whether any of this is useful

A product reaches a member **through an ingredient**:

```
goal → topics → articles → ingredients → (evidence) → products
```

A product with no `ProductIngredient` link appears on no journey and no
ingredient page. It is findable by search, ranked last, and nowhere else. So the
number worth watching after a sync is not how many products were written — it is
how many carry links.

`ingredients` is therefore the most important field in the payload, and it
behaves like this:

- **Omitted** — existing links are left alone ("I am not saying anything about
  ingredients").
- **Present** — it is the whole truth; links not in it are removed. Without this
  a sender could only ever add, and could never correct a mistake.
- A code this platform does not know is **reported** in `unknownIngredients` and
  never fails the product.

Ingredients themselves are never created here. An ingredient carries claims
about what it does to a body, and a sender that could invent one could invent
those.

## 6. Products that contain nothing

A supplement reaches a member through what is in it. A water filter, an air
purifier and a frying pan contain no ingredient, and until this existed they
belonged to no goal at all — however plainly they belong to one.

So a product may also carry **`topics`**:

```json
{ "code": "espring-uv", "name": "…", "brand": { … }, "topics": ["water-at-home"] }
```

Same rules as `ingredients`, deliberately, so a sender does not learn two
conventions for one act:

- **omitted** — existing links left alone
- **present** — the whole truth; links not in it are removed
- an unknown code is **reported** in `unknownTopics`, never invented

This does **not** move products earlier in the journey. §5's rule is that a
product is never the _beginning_ — goal leads to topics, and only then to
products. That is intact; what changed is that the last step no longer has to be
an ingredient:

```
goal → topics → ingredients → products      (supplements)
goal → topics ──────────────→ products      (everything else)
```

The journey response carries `productIds` on each topic, the same way it already
does on each ingredient, so the UI can show which path a product was reached by.

Topics are never created by an ingest. An ingredient carries claims about what
it does to a body; a topic is a heading a member navigates by. A sender that
could invent either would be writing somebody else's knowledge from outside.

## 7. A picture of the thing

The catalogue was text-only, and for a shop that would be restraint. This is not
a shop — nothing here is for sale (§8). It is a place members read and talk, and
_"is this the one on my shelf"_ is a question a paragraph answers badly.

```json
{ "code": "a5923th", "name": "…", "images": [{ "url": "https://…/A5923.jpg", "alt": "…" }] }
```

- **URLs, not bytes.** This endpoint takes a catalogue, not an upload.
- Order is the sender's order; the first picture is the one the card draws.
- Same omitted-vs-present rule as `ingredients` and `topics`.
- `alt` falls back to the product's name.

Each image row carries **two** location columns:

| column        | meaning                                              |
| ------------- | ---------------------------------------------------- |
| `url`         | where it lives at the source                         |
| `stored_path` | AVIORA's own copy — `NULL` until somebody mirrors it |

Two columns rather than one because the difference is the whole risk: a URL on
somebody else's CDN can vanish without warning, and a row that cannot say which
kind it holds cannot be audited for it. A sync never clears a `stored_path` —
re-sending a catalogue must not discard a copy somebody paid to make.

Mirroring is deliberately **not** what this route does. Fetching a few thousand
files from a third party is a decision with its own cost and its own permission,
and it belongs in a job somebody runs on purpose:

```bash
pnpm --filter @aviora/api mirror:product-images
pnpm --filter @aviora/api mirror:product-images -- --limit 50
```

Nothing calls it and it is on no schedule. It reads only rows with no
`stored_path`, keys objects by a digest of the URL, and fetches a picture shared
by two products once — so a second run after a half-finished first one picks up
exactly what is missing.

Once a copy exists, the card asks **this API** for it
(`GET /knowledge/product-images/:id/content`) rather than the source CDN. That
route is the one place in the knowledge module with no `@RequirePermissions`,
and the reason is the browser: an `<img>` sends cookies and nothing else, so it
cannot carry the tenant header a permission-gated route needs. It is safe
because of what the row is — a catalogue picture is global knowledge every
tenant can already read — and sign-in is still required.

## 8. What this route will not do

- **No prices and no stock.** This is the knowledge catalogue, not a shop —
  members read and talk here, they do not buy. Selling is `Offering` (docs/24),
  which is tenant-scoped, priced, and reached by a different route entirely.
- **No image BYTES.** Pictures arrive as URLs (§7); mirroring them is a separate
  job with a separate decision behind it.
- **No ingredients, articles, topics or goals.** Only brands, products, and
  links to ingredients and topics that already exist.
- **No deletes.** `status: "archived"` hides a product; nothing here removes a
  row that other rows may reference.
