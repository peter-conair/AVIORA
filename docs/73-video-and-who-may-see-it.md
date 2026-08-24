# 73 · Video, and who is allowed to see it yet

> **AVIORA** — a leader releases different training to different people in their
> line, and that is a sequencing decision rather than a permission one. The
> difference is the whole design.
>
> Status: **implemented** · docs/10 rows 93–94 had specced
> `POST /learning/assignments` since Sprint 0 and nothing ever built it · One
> cell of docs/07 changed · Builds on docs/67 (the path), docs/71 (object
> storage) · §11 records what the design got wrong

---

## 1. The refusal this has to get past

docs/37 §6 turned down exactly this shape once, and for a good reason:

> _"**No per-member article grants.** A grant table is a second permission
> system, and the team tree already expresses who should see what."_

That sentence still holds. A second answer to "may this person see this" is how
a codebase ends up with two security models that disagree, and the one that
disagrees quietly is the one that leaks.

So this design does not add a grant table. It adds a **sequencing** table, and
the distinction is load-bearing rather than rhetorical:

|                | Question                         | Answered by                              |
| -------------- | -------------------------------- | ---------------------------------------- |
| **Permission** | _May_ this person ever see this? | team scope + entitlement — **unchanged** |
| **Assignment** | Should they see it **now**?      | this document                            |
| **Progress**   | Did they actually watch it?      | docs/67's `learning_progress`, extended  |

The invariant that keeps the two apart is one line, and every route below
enforces it:

> **An assignment can never widen what a member is permitted to see.**
> It reveals within the permitted set; it never enlarges it.

A member whose plan lacks `course.access` gains nothing from being assigned a
course. A leader cannot assign to somebody outside `accessibleTeamIds`. Remove
every assignment row in the database and no member gains access to anything —
which is the test of whether a table is a permission system or not.

## 2. Why a training video would ever be hidden

Worth writing down, because "hide the training" deserves suspicion.

**Legitimate:**

- **Sequencing.** A stage-4 video shown on day one is not information, it is
  discouragement. docs/67 §4 already argues that somebody four names into a name
  list is not ahead of the path.
- **Readiness.** Compensation mechanics (docs/69) mean nothing to somebody who
  has not had a first customer, and mean a great deal the week after.
- **Paced programmes.** 6WNY week 3 opening before week 2 is finished breaks the
  programme docs/64 describes.
- **Leader material.** Content about running a team is not for somebody who does
  not have one yet.

**Not legitimate, and this product will not help with it:**

Withholding material to keep a downline dependent. In a network business that is
a real and well-documented behaviour, and a system that hides content
_invisibly_ is a tool for it. §5 is the design answer.

## 3. The policy lives on the lesson, not on the person

The gate is a property of the **content**, declared once by whoever authored it:

```
Course.releasePolicy
  'open'           anyone in scope, any time      ← the default
  'on_assignment'  visible only once released
```

Defaulting to `open` matters. It means the library is open unless somebody
deliberately said otherwise, rather than shut unless somebody deliberately
opened it. A tenant that never touches this feature has a completely open
library and no per-member rows at all.

Resolution is one function with one answer, and every screen calls it:

```
visible(member, course) =
      course.status = 'published'
  AND entitled(member, 'course.access')
  AND ( course.releasePolicy = 'open'
        OR  a live assignment exists for (member, course) )
```

Three ANDs. Assignment is the weakest of them and can only ever be the last one
to fail.

## 4. Rules do the work; the leader does the exceptions

A leader with thirty people in their line will not hand-pick videos forever, and
a design that assumes they will is a design that gets used twice and abandoned.

So a course may carry a release **rule**, evaluated against the evidence docs/67
§5 already computes — the goal row, the name list, customers, referral edges,
`learning_progress`. No new evidence, no second source of truth about where
somebody is:

```
releaseWhen: { after: 'course:path-basics' }      previous course completed
             { after: 'stage:first_customer' }    a path stage cleared
             { after: 'days:14' }                 fourteen days after joining
```

The leader's job becomes the exception rather than the rule:

| Leader action     | Effect                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ |
| **Release early** | A manual assignment satisfies §3 even when the rule has not fired.                         |
| **Hold back**     | A manual hold keeps it shut even when the rule has fired — and **requires a reason** (§5). |
| **Nothing**       | The rule decides. This is the case the design optimises for.                               |

**Assign at course level, sequence within a course by rule.** Per-lesson
assignment doubles the size of the leader's screen and asks them to make a
decision they mostly do not have an opinion about; "finish week 2 before week 3"
is a rule, not thirty separate judgements. A course that genuinely needs
per-video control is a course with one lesson in it, and that costs nothing.

## 5. A locked lesson says that it is locked

docs/37 §4 answers **404** for an article the caller may not read, on the
grounds that _"there is a document here you may not see" is itself information
about another team_. That rule is right and does not change.

**This is a different situation and gets the opposite answer.** A lesson inside
your own curriculum, held by your own upline, is not another team's secret. The
member sees it, greyed, with the reason:

```
✓  Week 1 — starting, and the measurements        เรียนจบแล้ว
✓  Week 2 — eating through the week               เรียนจบแล้ว
🔒 Week 3 — what to do when it stalls             เปิดเมื่อเรียนบทที่ 2 จบ
🔒 Week 4 — clean food                            อัพไลน์ยังไม่เปิดบทนี้
```

Two reasons, and they read differently on purpose. A rule-based lock explains
itself and tells the member what to go and do. A manual hold names that a person
made a decision — which is exactly the visibility that stops §2's illegitimate
case from being invisible.

The line to hold: **cross-team content is a 404; in-scope-but-unreleased content
is a lock with a reason.** Anything else either leaks another team's library or
lets a leader hide the curriculum from the person following it.

## 6. The data

Four additions. No change to `Course` beyond one column.

```
LessonAsset                              one lesson, several files
  tenant_id · lesson_id
  kind          'video' | 'captions' | 'thumbnail'
  locale        'th' | 'en' | null
  storage_key   opaque, returned by StoragePort.put — never constructed
  content_type · byte_size · duration_seconds
  @@unique([lesson_id, kind, locale])

Course.release_policy   'open' (default) | 'on_assignment'
Course.release_rule     jsonb, nullable — §4

LearningAssignment                       the sequencing table, NOT a grant table
  tenant_id · member_id · course_id
  state         'assigned' | 'held'
  source        'manual' | 'rule'
  assigned_by_member_id · assigned_at
  due_at? · reason?                      reason REQUIRED when state = 'held'
  @@unique([member_id, course_id])

LessonView                               finer than learning_progress
  tenant_id · member_id · lesson_id
  position_seconds     where they stopped
  watched_seconds      how much actually elapsed under play
  completed_at?
  @@unique([member_id, lesson_id])
```

`captions` is not a nicety. The content is bilingual everywhere else in this
product, and a Thai video with no Thai captions is unusable on a phone in a
noisy room — which, per docs/72, is where this will actually be watched.

### `position_seconds` is not `watched_seconds`

The two look redundant and are not. Position alone means dragging the scrubber
to the end marks a lesson complete, and the moment a leader treats completion as
a compliance number, that is what will happen. `watched_seconds` accumulates
from playback heartbeats instead.

It is worth being honest about the strength of this: it measures effort, it does
not prove attention, and a determined person defeats it. It is there so the
default path is truthful, not to catch anybody.

## 7. Serving the bytes — the port cannot do it yet

`StoragePort.get(key)` returns `{ body: Buffer }` (docs/71). For a photograph
that is correct and simple. For video it fails twice:

1. **Memory.** A 200 MB file per concurrent viewer, buffered in the API.
2. **Range.** No `Accept-Ranges`, no `206`. There is no seeking — and **iOS
   Safari will not play a `<video>` from a server that does not answer Range
   requests at all.** Given docs/72 exists because this product is used on a
   phone, that is not a performance note; it is the feature not working.

So the port gains one optional method, and the adapters that can do it implement
it — S3 passes the `Range` header through, local disk uses a bounded read
stream:

```ts
getRange?(key: string, range?: { start: number; end?: number }): Promise<{
  stream: Readable;
  contentType: string;
  contentLength: number;   // of THIS response
  totalLength: number;     // of the whole object
} | null>;
```

The controller answers `206` with `Content-Range` when a range was asked for,
`200` with `Accept-Ranges: bytes` when it was not, and `416` when the range
cannot be satisfied.

**The port's central rule survives unchanged:** every byte still passes through
this API, and no caller ever receives a storage URL. docs/71 states the reason
for photographs and it is not weaker here — a URL that works without the API is
a training library with its access control removed.

### Caching is where video and photographs differ

docs/65 serves photographs `private, no-store`, correctly: a consent photograph
should not sit in a browser cache. A video served `no-store` re-fetches from
byte zero on every seek, which on a phone is the difference between usable and
not.

Training video is not a consent photograph. `private, max-age=300` lets the
player keep the segments it is playing, and the material is a lesson rather than
somebody's body. **This decision must be verified on a real iOS device before it
ships** — every browser handles Range plus caching slightly differently, and
this is the one part of the design that cannot be settled by argument.

### Upload

Authoring is done by tenant admins, not members, so upload volume is low and a
size-capped buffered upload is survivable to start. Multipart upload is the
follow-up, and the trigger for doing it is the first tenant who cannot upload
the file they have — not a number guessed here.

## 8. What a leader may see about a member

The leader needs enough to coach and no more:

| Shown                                     | Not shown                        |
| ----------------------------------------- | -------------------------------- |
| not started · in progress (%) · completed | when they watched                |
| how many courses are outstanding          | how many times                   |
| the assignment they were given, and when  | what time of day, on what device |

The reason is the same one docs/28 §2 gives for keeping health data off the team
dashboard. A completion percentage supports the conversation a leader should be
having. A viewing timestamp supports a different conversation, and the product
should not make that one easy.

## 9. Permissions — one cell of docs/07 has to change

Everything else here reuses existing machinery. This does not:

| Permission        | docs/07 today     | Needs to be                           |
| ----------------- | ----------------- | ------------------------------------- |
| `learning.assign` | `TENANT_ALL` only | `TENANT_ALL` + **`DESCENDANT_TEAMS`** |

As specced, only a tenant administrator can assign — which makes the feature the
user actually asked for impossible. The scope it needs is the one
`knowledge.team.manage` already has for exactly the same reason (docs/37 §2):
**writing goes down the tree.** A leader may assign to the teams they lead and
everything beneath them, resolved by `TeamScopeService.accessibleTeamIds` — the
same call, so there is no second answer to "which members may this person act
on".

### Routes

| Method   | Path                                  | Permission                                                     |
| -------- | ------------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/learning/courses`                   | `learning.view` — now carries release state per course         |
| `GET`    | `/learning/lessons/:id/media?locale=` | `learning.view` — Range-aware, §7                              |
| `POST`   | `/learning/lessons/:id/progress`      | intrinsic SELF                                                 |
| `GET`    | `/learning/assignments?memberId=`     | `learning.assign`                                              |
| `POST`   | `/learning/assignments`               | `learning.assign` — `{ memberIds[], courseId, dueAt?, note? }` |
| `DELETE` | `/learning/assignments/:id`           | `learning.assign`                                              |
| `GET`    | `/learning/assignments/board`         | `learning.assign` — members × courses, for the leader's scope  |

Rows three onward are docs/10's 91–94, finally built. The board is the one
addition, and it is what makes the feature survive contact with thirty people:
a grid the leader reads down a column and assigns across a row, rather than
thirty visits to thirty member pages.

## 10. What this refuses

- **No DRM, and no pretence of it.** Anyone who can watch a video can record
  their screen. Saying so is better than shipping a padlock icon that implies
  protection nobody has.
- **No transcoding or adaptive bitrate.** One file per locale. A 1080p master on
  a 3G connection is unwatchable, and HLS is the real answer — but it is a
  pipeline, not a column, and it should be built when a tenant has enough video
  for it to matter.
- **No per-lesson assignment.** §4 gives the reason. A one-lesson course is the
  escape hatch.
- **No assignment to a team as a unit.** docs/10 row 93 says "member/team", and
  a team-level assignment sounds cheaper until somebody joins the team next
  week: does the assignment reach them? Both answers are defensible, which is
  the signal that the question needs a real requirement behind it rather than a
  guess. Bulk-assigning every member of a team is one call with a list of ids
  and has no such ambiguity.

## 11. What building it changed

Four things the design above got wrong or left open, recorded here rather than
quietly corrected, because the reasoning is the part worth keeping.

### A hold cannot shut an OPEN course

§3 originally let a hold outrank everything, including an open policy. Written
down, that is a leader being able to close the whole library one course at a
time — the exact behaviour §2 says this product will not help with.

The rule is now a separation of powers: **the tenant decides which courses are
sequenced at all; the leader sequences within those.** `LearningReleaseService`
checks the policy before it looks at the assignment, and
`LearningAssignmentService.hold` refuses an open course at the door with a
message naming the fix — so the answer is the same whether you ask the API or
read the rows.

### The board is one course at a time, not a matrix

§9 asked for a members × courses grid. It is the right mental model and the
wrong screen: it does not fit a phone, which docs/72 exists because this product
is used on. The board picks one course and lists every member in scope beneath
it — the same act as reading down a column, and also the shape of the real
decision ("open week three for these six people").

### Two decisions about the audit log

`POST /learning/assets` **is** audited. Replacing a video in place leaves no
other trace: the row keeps one storage key and the old object is deleted, so
without a row there would be no record that the lesson somebody watched last
week is not the one there now.

`POST /learning/lessons/:id/progress` is **not**, and says so in
`audit-coverage.spec.ts` with the reason. It is a playback heartbeat — one every
ten seconds from every member watching anything, the most frequent write in the
product. `lesson_views` already holds everything an audit row could say, and
auditing it would bury the sensitive rows the log exists for.

### `express` is now a direct dependency of the API

Mounting a raw body parser on one path needs `express.raw`, and it was only
present transitively through `@nestjs/platform-express`. A package that is
imported directly should be declared directly; under pnpm's strict layout it is
not merely untidy but unresolvable.

## 12. Still unverified

**Playback in a browser, and iOS in particular.** The Range implementation is
asserted byte-for-byte through real HTTP in `video-learning.e2e.spec.ts` —
closed ranges, open ranges, suffix ranges, 416 with the real length, and the
CONTENT at each offset rather than only the headers. What no test here can prove
is that Safari on an iPhone is happy with the combination of `206`,
`Accept-Ranges` and `Cache-Control: private, max-age=300`. §7 already said that
decision could not be settled by argument; it still cannot, and it is the first
thing to check on a real device.

**Tenant resolution for the `<video>` element.** The element cannot send an
`X-Tenant-ID` header, so it depends on the tenant resolving from the host —
which is true on a production subdomain and not true on `localhost`. This is not
new: the customer photograph in `CustomerCard` has exactly the same shape and
the same limitation. It is written down here because two features now share it,
which makes it a thing to fix once rather than a quirk of one screen.
