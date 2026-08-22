# 55 · Duplicate leads, and the index that makes the check survive encryption

## 1. The gap

`POST /crm/leads` accepted the same person any number of times. Two salespeople
could each hold a lead for one contact without either knowing, a web form that
double-submitted made two, and a customer who enquired twice became two records
whose follow-ups and interactions each told half the story.

Nothing detected it, because there was no way to ask "is this contact already
here?" — the CRM had no lookup by email or phone at all.

## 2. Two ways to say "the same person"

`ContactKeyService` is the single place that decides, because the write path and
the check have to agree exactly. A lead stamped one way and searched another is
a lead the check cannot see, and a duplicate check that quietly finds nothing is
worse than none: it answers "no duplicate" with authority.

**With `AVIORA_BLIND_INDEX_KEY` set** (the intended state) matching goes through
`email_bidx` / `phone_bidx` — the HMAC digests from docs/54. This is the point of
building it this way round: when the contact columns become ciphertext, the
duplicate check does not change at all.

**Without the key**, matching compares the plaintext columns, normalised the
same way. That fallback exists so a deployment that forgot one variable loses
the index rather than the ability to create a lead — the blind index fails
closed, but taking lead creation down over a missing env var is the wrong end of
that trade. It is honest only while those columns _are_ plaintext, and docs/54
§4 already lists moving off it as a prerequisite for encrypting them.

Both paths are tested, including the fallback, because an untested fallback is
how a check silently stops checking.

Normalisation is shared with docs/54 §2: emails trim-and-lowercase, phones
reduce to their last 9 digits so `+66 81-234-5678` and `0812345678` are one
number. The API now also trims contact input before validating — a form that
posts `"  ada@example.com "` is a real form, and rejecting it with a 400 hid the
duplicate instead of reporting it.

## 3. What happens on create

An **open** lead matching by email or phone anywhere in the tenant returns
`409 CONFLICT` naming the owner. Three deliberate choices:

- **Open only.** Someone who enquired last year and comes back is a new lead,
  not a duplicate. Closed and converted leads do not block.
- **Tenant-wide, not owner-scoped.** The duplicate worth catching is usually
  someone else's. A check scoped to your own book would miss exactly that case
  and still report no duplicate.
- **`allowDuplicate: true` overrides it.** Two people really do share a family
  phone or a shop address. The check exists to stop the accidental double, not
  to overrule the person — and a check with no override gets worked around by
  typing a fake email, which is worse than a duplicate.

A contact with nothing to match on never matches. This sounds obvious and is
the easiest bug to write here: an unguarded `OR` over two null keys matches
every row with a blank email, which would block every walk-in who gave only a
name. A test pins it.

The check runs **inside the insert transaction**, so two simultaneous submissions
of one web form cannot both pass it.

## 4. What the caller is allowed to learn

`GET /crm/leads/duplicates?email=&phone=` returns matches with a deliberate
asymmetry:

| Caller can read that lead | Gets                                             |
| ------------------------- | ------------------------------------------------ |
| yes                       | id, name, owner, created date                    |
| no                        | **owner's name only** — `id: null`, `name: null` |

Someone who cannot read a colleague's book still learns the contact is taken and
who to talk to. That is the minimum required for the feature to function at all:
"this is a duplicate" without "and Somchai has it" leaves the caller with nothing
to do about it.

It does mean any member with `crm.lead.view` can discover whether a given address
is in the tenant's CRM. That is inherent — the `409` on create reveals the same
thing — but an explicit endpoint makes probing cheap and quiet, so it carries
`@RateTier('expensive')` (20/min, docs/49). At the default read budget it would
answer a few hundred addresses a minute, which is an enumeration tool rather
than a duplicate check.

## 5. The columns

`20260822150000_crm_contact_blind_index` adds four nullable columns and four
indexes leading with `tenant_id` (docs/08 §43). Additive and reversible: nothing
existing is read, rewritten or dropped.

Backfill is not in the migration, because computing a digest needs the key and
SQL does not have it — `pnpm --filter @aviora/api backfill:crm-bidx` does it, and
lives in `apps/api` so it uses the same normalisation the API writes with. A
backfill carrying its own copy of "how a phone number is spelled" produces an
index that disagrees with every row written afterwards, and the disagreement
stays invisible until the check stops finding things.

It writes derived data only and never touches a contact, so it is safe to rerun
and undone by nulling the two columns.

## 6. Contact columns are still plaintext

Unchanged, and deliberately (docs/13 §11.1, docs/54 §4). What this sprint bought
is that the blind index is now **load-bearing rather than speculative**: it is
the mechanism a real feature uses every time a lead is created, so the day the
contact columns are encrypted, this path is already the one in use and already
proven.
