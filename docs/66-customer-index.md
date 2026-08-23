# 66 · The customer index card

## 1. The card

`CUSTOMER INDEX` — name, ABO#, expiry, ID#, date of birth, phone, email, a NOTE
box, and twelve boxes for the year's SOP.

Most of it is fields on a record and needs no explanation. Two parts do.

## 2. The identity number is not like the other fields

ID# is the most identifying thing on the card and the least often needed. It is
stored through `FieldEncryptionService` — AES-256-GCM, fail-closed, so with no
key configured it **throws rather than writing plaintext**.

The column is called `id_number_encrypted`. A column called `id_number` holding
ciphertext is how somebody later writes plaintext into it and nobody notices.

**The card never returns it.** `GET .../card` answers `hasIdNumber: true` and
nothing more. Returning it with the card would put an identity number on
somebody's screen every time they glanced at a customer, and nothing would
record that it had happened.

Reading it is a **separate, audited act**: `POST .../id-number`. POST rather than
GET because it is an act, and because a GET invites a browser or a proxy to
repeat it without anybody asking. The audit row records that it happened and
never what was read — an audit row repeating an identity number would put it
back in the clear in a table read by more people than the card is.

## 3. Twelve boxes, two kinds of tick

A month is **ordered** when a real paid order exists in it. That is derived, and
those months cannot be hand-ticked: `PUT .../months` refuses a month that
already has a paid order, because a hand tick disagreeing with the orders table
is a month nobody can resolve.

Where the system sees no order, a hand tick counts. **A lot of this business is
transacted outside the system**, and a grid that could only see what the system
sold would be blank for most customers and wrong about all of them.

Every box carries `source: 'computed' | 'manual'`, because a month the system
saw and a month somebody remembered are not the same claim — the same rule as
docs/58 §3.2 and the start path.

## 4. Why the grid earns its place

The paper card cannot answer _"who has stopped ordering"_. Twelve boxes and a
`source` on each can: a customer with ticks through July and nothing since is a
question, and one nobody has to remember to ask.

That is the same reasoning as the tracker's stalled report (docs/59 §5), and it
is the only reason to prefer this to the card it replaces.

## 5. Scope

The card is a customer record and goes through `CrmScopeService` like every
other one: a member sees their own book, a leader their org's, and a test pins
that somebody else's card is a 404 rather than a 403 — an outsider should not
learn that a customer exists by being refused.

## 6. It passed here and failed on CI

The three assertions about the identity number failed on CI and nowhere else,
and none of them mentioned a key: `expected false to be true`, `null and string
is invalid for this assertion`, `expected 0 to be greater than 0`.

One cause. `FieldEncryptionService` fails closed, **CI deliberately carries no
PII key**, and every suite that needs one sets its own with `??=`. This suite
never had — it had never encrypted anything before the card arrived. The save
threw, and three later assertions reported the consequences instead.

Fixed by setting the key in this suite like all the others, and by asserting the
save's own status so the next failure of this shape lands where it happened
rather than three assertions downstream. Reproduced locally by unsetting the key
before believing the fix.

## 7. The screen (Sprint 48)

Sprints 46 and 47 shipped API-only, which left consent, photographs and the card
built and unreachable — the failure docs/63 was written about, repeated by the
person who wrote it.

The card opens **under the customer list** rather than on a page of its own. The
list is how somebody finds a customer, and losing it to navigate back is the
friction that stops cards being kept up to date.

Three things on the screen are deliberately awkward, and all three are the
point:

- **The identity number is never rendered.** A masked field, a button, and the
  sentence _"การกดแสดงเลขจะถูกบันทึกไว้ใน audit log"_ shown **before** it is
  pressed rather than after.
- **A month the system saw for itself is not clickable.** Not "clickable and
  then refused" — the server refuses too, but a button that looks pressable and
  is not teaches people the screen is broken.
- **The photo section does not exist without consent.** Not a disabled uploader:
  there is nothing to press until consent is recorded, and the withdrawal button
  states what it destroys before it is pressed.

`img` points at the API's own origin. A relative path would ask the web server
for a photograph it has never heard of — and the cookie travels because the two
hosts are same-site, which is the only reason an `<img>` can be used for an
authenticated route at all.
