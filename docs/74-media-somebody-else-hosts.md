# 74 · Media somebody else hosts

> **AVIORA** — a tenant's training already lives on YouTube, as fifteen unlisted
> playlists. Embedding it is easy. Being honest about what that does to docs/73
> is the part worth writing down.
>
> Status: implemented · Extends docs/73 · Closes docs/10 rows 84–89

---

## 1. Two kinds of asset now, and the row says which

docs/73 assumed every lesson's bytes were ours: in our bucket, through our API,
behind the release check. `lesson_assets` therefore had one shape.

It now has a `provider`:

| `provider` | Bytes                        | What a release means                          |
| ---------- | ---------------------------- | --------------------------------------------- |
| `storage`  | ours, streamed by `getRange` | **enforced** — a locked course serves nothing |
| `youtube`  | somebody else's, embedded    | **advisory** — see §2                         |

The column exists so nothing downstream has to infer which promise it is
making. The database enforces the shape too: a `storage` row without a key is a
lesson that looks playable and is not, and a `youtube` row with a storage key is
a claim to own bytes we do not.

## 2. What it costs, stated plainly

The playlists are **unlisted**. Unlisted means not searchable and not on the
channel page — and it also means **anyone holding the link can watch, with no
account, no login and no permission check anywhere**.

docs/71 states the rule this breaks:

> a URL that works without passing through this API is a photograph with no
> access control on it

An unlisted YouTube link is exactly that URL. So for a `youtube` asset:

```
leader opens PACK 07 for A, not for B
        ↓
A forwards the link to B
        ↓
nothing in this product knows, sees, or can prevent it
```

**Releasing controls what this product shows. It does not control what YouTube
serves.** That is not a bug to be fixed later at this layer; it is what
embedding somebody else's unlisted video means.

Three things follow, and all three are built:

- **The API says so.** `POST /learning/assets/external` answers with
  `accessControl: "advisory"` and a sentence, so no screen has to invent one.
- **The board says so.** Every course carries `mediaAccessControl`, and the
  leader sees an amber note before choosing who to release to — not afterwards,
  when a video turns up somewhere they did not send it.
- **The one guarantee left is kept, and tested.** A course a member has not been
  released hands out **no video id at all**. The link is the access control, so
  not handing over the link is the whole of what this product can still promise
  — and `video-learning.e2e.spec.ts` asserts the locked response contains no id.

If real enforcement is ever needed, the path is to host the files (docs/73 §7
already streams them properly) — which needs the content owner's permission,
and is a conversation rather than a commit.

## 3. The id, never a URL

`external_id` holds the eleven-character video id, and a database CHECK refuses
anything else.

The reason is specific. Somebody pasting `watch?v=abc123&list=PL8t9…` would put
**the playlist id** — the link to all six videos — into a column that a template
renders into a page. The narrow column is what stops one careless paste from
handing over more than the lesson it was for.

## 4. Getting ninety lessons in

Two doors into the same room, applying the same shapes.

**The API**, for ordinary authoring: `POST /courses`, `PATCH /courses/:id`,
`POST /courses/:id/lessons`, `POST /learning/assets/external`. These are docs/10
rows 84–89, unbuilt since Sprint 0. The gap mattered more than it looked: course
content belongs to the tenant (docs/67 §2), and without these routes the only
way to get a real curriculum in was to write it into this codebase's seed —
which is the thing that paragraph forbids.

**The importer**, for a list somebody else already made:

```bash
pnpm --filter @aviora/db courses:import --tenant <uuid> --file data/gg-pack-2026.json --dry-run
```

Idempotent by course code: a second run reconciles rather than duplicates,
because a manifest gets re-captured when the source playlist changes. It
**publishes nothing to anybody** — who sees what is a leader's decision
(docs/73), and an importer that also released would be quietly making it.

The manifest is data, not code, and it is a snapshot: the titles were YouTube's
on the day it was captured and can change there without changing here.

## 5. What this refuses

- **No downloading.** Mirroring the files would give real access control and
  break YouTube's terms, and the content is not ours to copy. §2 names the
  legitimate route if it is ever needed.
- **No watch tracking on an embed.** The iframe is another origin and this page
  cannot see inside it. Reporting progress would mean inventing numbers, which
  is worse than having none — a leader would act on them.
- **No pretending.** No padlock over a YouTube lesson, no "restricted" badge, no
  wording that suggests a hold does something it does not.
