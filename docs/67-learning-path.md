# 67 · The learning path — what to know, what to do

## 1. Both halves existed; nothing joined them

Two questions run through this whole product, and the answers were lying in
separate places:

| | Where it was | What was wrong with it |
|---|---|---|
| **what to DO** | the start path (docs/63) | covered the first stage and stopped |
| **what to KNOW** | `recommendedCourseIds` per rank (docs/62 §4) | empty until an admin fills it — so, in practice, nothing |

Between "you have your first customer" and "you are 6%" there was no answer to
either question. That gap is most of the first year of somebody's business.

## 2. Five stages, both questions at each

```
1 รู้ว่ากำลังทำอะไร  →  2 ลูกค้าคนแรก  →  3 ผู้ร่วมธุรกิจคนแรก
                          →  4 สอนให้ทำ ไม่ใช่ทำให้  →  5 สร้างสาย
```

Each carries **courses** and **actions**. A reading list is not a plan, and a
task list with nothing behind it is guesswork.

Seven courses and eighteen lessons seed on first read — titles and headings, a
spine for the business to hang its own material on. Empty lessons are honest
about being empty; writing the words would put this codebase's opinions into a
tenant's training.

## 3. Duplication is its own stage

Stage 4 clears only when **somebody you sponsored sponsors somebody**.

It is the one stage that cannot be reached by working harder alone, which is
exactly why it gets named rather than folded into "build your team". A member
who never clears it has a job, not a business, and nothing else on the path will
tell them so.

## 4. `current` is the earliest gap, not the furthest achievement

Real life does not go in order. The test tenant's seller has closed customers
while their name list is still short — stage 2 cleared, stage 1 not.

`currentStageKey` points at **stage 1**. Somebody selling on four names is not
ahead of the path; they are one short conversation from running out of people,
and a screen that congratulated them for reaching stage 2 would be lying
politely. The stage list shows the truth either way: cleared stages are ticked
wherever they fall.

## 5. One source of truth about where somebody is

The path derives its stages from **the same evidence the start path reads** —
the goal row, the name list, `learning_progress`, customers, referral edges. A
test asserts the two agree about the customer step.

Two screens telling a member they are at different places is worse than either
being wrong on its own, because it teaches them to trust neither.

## 6. The last stage does not finish

Stage 5 has `clearedBy: 'never'` and the screen says so. Building lines has no
completion; the percentage ladder (docs/62) takes over from there, and a tick
against it would be a lie with a certificate on it.
