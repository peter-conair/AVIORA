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
