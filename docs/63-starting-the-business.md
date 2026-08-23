# 63 · Starting the business

## 1. The gap

Spec §25 asks for a configurable onboarding journey. docs/33 recorded §24–25 as
covered by `modules/learning` — the same over-claim as §41 Prospecting, and
wrong for the same reason: **a course list is not a journey.**

What a brand-new member actually met was a dashboard whose every card said
_empty_ — no membership activity, no goals, no learning, no team — and nothing
anywhere saying which one to touch first. Every piece of the first thirty days
existed by Sprint 42. None of it was pointed at.

## 2. Eight steps, in the order the business does them

```
เขียนความฝัน → ตั้งเป้าเดือนนี้ → เขียนรายชื่อ 10 คน → เริ่มใช้สินค้าเอง
   → เริ่มเรียนคอร์สแรก → นัดพบโค้ช → ลูกค้าคนแรก → ผู้ร่วมธุรกิจคนแรก
```

Ten names rather than the sheet's twenty: filling the sheet is the exercise
(docs/56 §3), but a first step that demands the whole exercise is a first step
nobody takes.

## 3. Six of the eight read themselves

This is the point of building it rather than printing it. A goal row exists or
it does not. A name list has ten names or it does not. There is a
`learning_progress` row or there is not.

**Asking somebody to tick a box the system could have looked up is how a
checklist stops being believed** — on about the third day, when they notice it
does not know something it obviously knows.

| Step                    | Proof                                             |
| ----------------------- | ------------------------------------------------- |
| Write your dream        | `business_goals.life_goal` is set                 |
| Set this month's target | a goal row for **this** month with a target on it |
| Write 10 names          | leads on either name list                         |
| Use the products        | any business checklist log                        |
| First course            | any `learning_progress` row                       |
| First customer          | any customer owned                                |
| First partner           | any live referral edge                            |
| **Meet your coach**     | **nothing — the member ticks it**                 |

The last one is manual because the paper says _"Meet Coach for Script"_ and no
table records a conversation. Better to ask than to guess, and the card says
which kind each step is (`อัตโนมัติ` / `ติ๊กเอง`) — a step the system read and a
step somebody ticked look identical otherwise (docs/58 §3.2).

**A derived step cannot be ticked.** `PUT /start/customer` is a 403: otherwise a
member could claim a first customer they do not have and the path would say
something their own records flatly contradict.

## 4. Where the two manual ticks live

On the tracker engine (docs/59), as a template coded `start` — a manual step
_is_ a dated tick against a named step, which is exactly what that engine
stores. No new table.

It is created with `isActive: false` so it never appears among the sheets a
coach works through for somebody else, and a test pins that.

Not audited: only the steps nothing can observe are tickable at all, and
`tracker_marks` already records when and by whom.

## 5. The card removes itself

`StartHereCard` renders nothing once the path is complete. A permanent "getting
started" panel on the screen of somebody who started a year ago is clutter, and
clutter is what teaches people to stop reading a screen.

It needs no permission beyond tenant membership — gating a new member's first
screen behind a grant would hide it on the day their grants are thinnest.

## 6. What "focus on starting" changed

Nothing was built that did not already exist except the reading. The goal sheet,
name lists, checklist, courses, CRM and referral graph were all there by Sprint
42; the start path is eight queries over them and one card.

That is the honest summary of the sprint, and the reason it is worth recording:
the product was finished and unenterable.

## 7. It broke the sheets, and only a browser could tell

`StartService` creates a tracker template coded `start`. `TrackerService`
decides whether to seed the three real sheets by asking whether the tenant has
**any** template at all.

So a member who opened the **dashboard** before the **workbook** — which is the
normal order, since the dashboard is where you land — created the `start`
template first, and the tracker then considered the tenant already set up. The
Follow Up Sheet, Diamond Check List and 6WNY protocol never seeded. Not "later":
never, because the guard would keep seeing the same template every time.

Every API test passed. Each suite exercised one module, and nothing had ever
called `/start` and `/tracker/sheets` in that order — a real visit does, because
a real visit starts at the dashboard.

The count now excludes the internal template, and a test walks the exact order
that broke it: provision a tenant, call `/start`, then ask for the sheets.
