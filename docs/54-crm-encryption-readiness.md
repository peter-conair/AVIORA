# 54 · CRM contact encryption: rehearsed, not performed

## 1. What this is and what it is not

`leads` and `customers` still hold `name`, `email` and `phone` **in plaintext**,
protected by row-level security, tenant scoping and `CrmScopeService`. This
document does not change that.

What changed is that the two things standing between here and encryption are now
built and measured rather than argued about:

|                                                   | Before               | Now                                      |
| ------------------------------------------------- | -------------------- | ---------------------------------------- |
| "Encrypting `email` kills lookup-by-email"        | true, and unanswered | answered — blind index, tested           |
| "We do not know if the migration would lose data" | true                 | rehearsed on a copy of the real database |
| Contact columns                                   | plaintext            | **still plaintext**                      |

The remaining step is one `UPDATE`. It is deliberately not taken, for the reason
in docs/13 §11.1: it is a one-way door, and the key that opens it does not yet
have a custody story. Everything before that door is now done, so taking it is a
decision rather than a project.

## 2. The blind index

`HMAC-SHA256(index_key, normalised(value))`, in
`apps/api/src/common/crypto/blind-index.service.ts`.

Equal values give equal digests, so `WHERE email_bidx = $1` still finds a lead by
their email once `email` itself is ciphertext. Three things it depends on:

- **A key separate from `AVIORA_PII_ENCRYPTION_KEY`.** One key for both means one
  compromise both decrypts the data and confirms guesses about it.
- **Normalisation.** `Ada@Example.COM ` and `ada@example.com` are one address;
  `+66 81-234-5678`, `081-234-5678` and `0812345678` are one Thai number. Indexed
  unnormalised, each spelling is a different digest and every lookup misses.
  Phones normalise to their last 9 digits, which drops the country code and the
  trunk `0` that appear or vanish depending on who typed it.
- **Failing closed.** With no key configured the index would be a constant and
  every row would match every lookup, so it throws instead.

### 2.1 What it does not give you

A blind index is deterministic, and an email address is low-entropy. Anyone
holding the index key can test whether a **known** address is present, and can
see that two rows share one. That is inherent to searchable encryption, not a
defect in this implementation — it is written here because the word "hash"
invites the assumption that it is more.

It also only supports **exact** match. `LIKE 'ada%'` over encrypted email is gone
for good; a CRM that needs prefix search over contact fields needs a different
design, and should decide that before encrypting, not after.

## 3. The rehearsal

`pnpm db:crm-rehearsal` → `scripts/crm-encryption-rehearsal.sh`.

It copies the database, adds the blind-index columns to the **copy**, encrypts
every contact column there, and then checks the things that decide whether the
real migration is safe:

1. every contact is still findable by the email a person would type, including
   with the wrong case and stray spaces;
2. every contact is still findable by a phone number written a different way
   from the one stored;
3. every encrypted value decrypts back to **exactly** what was there — not most;
4. no plaintext is left behind, which catches a migration that silently skipped
   rows and then passed the checks above by reading what it wrote.

Last run: 276 rows across both tables, ~0.1s per table (≈2,000 rows/s), all four
checks green. At that rate the real tables would be written in well under a
second; the migration is a maintenance note, not an outage. Batched 200 rows per
transaction rather than one transaction for the table, so locks are not held for
the whole run.

Nothing is dropped, per docs/39 §2 — the script prints the `dropdb` for you.

### 3.1 The first run of this rehearsal was lying

It reported five green tests, one of which compared nothing at all: **no row in
the database has a phone number**, so the phone-lookup loop iterated an empty
list and passed. Phone normalisation is the fiddliest part of the whole
mechanism and it was the part going unexercised.

Fixed in both directions — the script now synthesises phones into the copy, and
the test asserts it actually compared something, so it can never silently pass
again. Verified by running it against a copy without phones and watching it fail.

This is the same shape as every other finding in this codebase's audits: a
control that reads as present and is not. It is recorded here because the number
"5 passed" was, for one commit, worth less than it looked.

## 4. What is still required before encrypting for real

1. **Key custody.** Where `AVIORA_PII_ENCRYPTION_KEY` and
   `AVIORA_BLIND_INDEX_KEY` live, who can read them, and how they are recovered.
   Losing them loses the CRM; there is no second copy of a customer's phone
   number.
2. **A rotation answer.** Rotating the encryption key means re-encrypting;
   rotating the index key means recomputing every index. Both are the same
   batched write as the migration, but both need the old key present while they
   run.
3. **Read-path changes.** Every CRM read must decrypt, and every lookup by email
   or phone must go through the index instead of the column. The rehearsal
   proves the data survives; it does not change a single service.
4. **The decision itself**, from someone who owns the consequence.

Until then docs/13 §11.1 stands, and it stands on measurement now instead of on
the absence of one.
