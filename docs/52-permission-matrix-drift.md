# 52 — The Matrix That Described a Different Product (Sprint 34)

> `docs/07` is listed as a source of truth for who may do what. It was written
> as a design-time model, the implementation went somewhere else, and nothing
> ever reconciled them.

## 1. The size of the drift

Comparing the keys `docs/07` names against `PERMISSIONS`:

|                                           |        |
| ----------------------------------------- | ------ |
| named in the doc, **not defined in code** | **61** |
| defined in code, **not named in the doc** | **45** |
| actually defined                          | 62     |

So a person configuring a role from that document would have granted
`platform.tenant.suspend`, `learning.course.publish` or `member.notes.manage` —
none of which exist, none of which would error, none of which would do
anything — and would never have discovered `knowledge.team.manage`,
`sponsorship.manage` or `partner.manage`, which do.

This is the same failure as every other one this session, in its most ordinary
form: **a document cannot fail.** Code that stops being true breaks a test; prose
that stops being true just sits there being read.

## 2. What was done

`docs/07 §0` now carries a **generated** matrix — every permission, its scope,
and which system role holds it at which scope — rendered from `PERMISSIONS` and
`SYSTEM_ROLES` by `pnpm --filter @aviora/db docs:permissions`.

`permission-matrix-doc.spec.ts` fails when the committed block and the code
disagree, and its message names the command rather than inviting an edit: the
next person to add a permission will not know they were supposed to hand-update
a table, which is precisely how this happened.

The test reads the catalogue **independently** of the renderer for its second
assertion, because if both read it the same wrong way they would agree with the
bug rather than catch it.

## 3. Why the old matrix is still there

Deleted, it would take with it a considered model of a permission system —
export permissions, notes permissions, billing separation, impersonation — that
somebody thought about properly and that this platform may well grow into.

It stays, marked as intent rather than fact, under a heading that sends a reader
to the generated section first. A design document describing where something is
going is useful. The harm was never that it was aspirational; it was that
nothing said so.
