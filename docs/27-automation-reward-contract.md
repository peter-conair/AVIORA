# 27 — Automation & Reward Contract (Sprint 11)

> Spec §51 (Automation OS), §45 (Reward OS), §23 (Member Growth Journey).

## 1. Automation is the outbox with rules on top

Every trigger in spec §51 — `member.created`, `rank.achieved`, `order.completed`,
`course.completed` … — is already a domain event in the outbox. So the
automation engine is not a new pipeline; it is **one more handler** on the
existing event bus that loads the tenant's rules and runs the matching ones.

```
AutomationRule       code · name · trigger_event · conditions (JSON) · actions (JSON)
                     priority · status
AutomationExecution  rule_id · event_id · member_id · status · result · error
```

- `UNIQUE (rule_id, event_id)` — **an event fires a rule at most once**, which
  is the same defence the commission run and the subscription renewal use. A
  replayed event cannot grant a second reward.
- An action that throws is recorded with `status = 'failed'` and its error; the
  other actions in the rule still run, and the other rules still run. One
  broken action must not silence the rest — the lesson the email handler taught
  in Sprint 3.
- Executions are the audit trail: what fired, on which event, and what it did.

### Triggers

Any event name in the shared `EVENTS` catalog. A rule naming an event that does
not exist is **rejected at creation** — a rule that can never fire is a typo,
not a configuration.

### Conditions

The same vocabulary as ranks and compensation (metric, comparator, threshold,
window, graph), plus payload matchers written the same way:
`{ payloadPath, comparator: 'eq', value }`. Only `eq` — ordering arbitrary JSON
is a meaning this contract does not have. A rule with no conditions fires on
every occurrence of its trigger.

### Actions

Only actions with a real adapter are accepted; the rest of spec §51's list is
**rejected at rule creation with the reason**, never silently ignored:

| Action                                                                                                         | Status                                    |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `send_notification`                                                                                            | in-app notification (notification module) |
| `grant_reward`                                                                                                 | grants a `RewardDefinition` to the member |
| `create_followup`                                                                                              | CRM follow-up for the member's owner      |
| `assign_course`                                                                                                | starts a learning assignment              |
| `send_email` / `send_line` / `run_ai` / `assign_coach` / `update_segment` / `create_task` / `trigger_workflow` | no adapter yet — refused at creation      |

`trigger_workflow` is deliberately absent: rules that fire rules are how an
automation engine becomes a loop nobody can trace. It arrives when there is a
depth guard to go with it.

### Automation never reacts to its own output

Refusing `trigger_workflow` is not enough on its own. Rewards emit
`RewardGranted`, and any event in the catalog is a legal trigger, so a rule
that grants a reward on `RewardGranted` would chain for ever — the same loop,
through the back door. **An event produced by an automation action does not
trigger rules.** No counter, no depth limit: the cycle cannot start.

Nothing is lost. A rule's actions are a _list_, so anything that should happen
alongside an automated grant — a notification, a follow-up — belongs in the
same rule, where a person reading the rule can see it.

## 2. Rewards are recognition, and stay separate from money

Spec §45: _"Separate reward from monetary commission."_

```
RewardDefinition  code · name · type · config (JSON) · status
RewardGrant       reward_id · member_id · source_type · source_ref · status · granted_at
```

| Type                                                       | What happens                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `points`                                                   | delegates to gamification — points live in one place only                                                                             |
| `badge`                                                    | delegates to gamification                                                                                                             |
| `course_access`                                            | grants access to a course                                                                                                             |
| `coupon`                                                   | issues a commerce coupon to that member                                                                                               |
| `membership_upgrade`                                       | records the intent; changing a plan stays a deliberate act                                                                            |
| `product` · `event_ticket` · `recognition` · `certificate` | recorded grants — the fulfilment is off-platform                                                                                      |
| `cash`                                                     | **recorded, never paid.** Paying is compensation's job, and even there money moves through a payout provider that does not exist yet. |

A grant is revocable and never deleted: `status = 'revoked'` keeps the history
of what was given and taken back.

## 3. The growth journey already exists

Spec §23 asks for configurable growth pathways whose stages require learning,
activity, customers, team, goals or sales. That is the **rank engine** from
Sprint 9 with different words: stages are rank definitions, requirements are
rank qualifications, and both are tenant configuration.

Building a second ladder would mean two engines disagreeing about what a member
has achieved. So this sprint does **not** add one. What it adds is the part
§44's dashboard asks for and ranks lacked:

- `RankDefinition.recommendedCourseIds` — the learning a member can do next,
- and rewards on `RankAchieved`, which the automation engine now provides with
  no rank-specific code at all.

## 4. Permissions and entitlement

| Key                 | Held by             | Scope        |
| ------------------- | ------------------- | ------------ |
| `automation.manage` | owner               | `TENANT_ALL` |
| `reward.manage`     | owner               | `TENANT_ALL` |
| `reward.view`       | MEMBER (own), owner | `SELF`       |

No entitlement gates automation: it is tenant machinery, not a member
capability. Reward _viewing_ is permission-scoped for the same reason rewards
are not sold — a member sees what they were given.

## 5. Routes

| Method   | Path                     | Permission          | Notes                                             |
| -------- | ------------------------ | ------------------- | ------------------------------------------------- |
| `GET`    | `/automation/rules`      | `automation.manage` | Rules with their conditions and actions.          |
| `POST`   | `/automation/rules`      | `automation.manage` | Validates trigger, conditions and every action.   |
| `PATCH`  | `/automation/rules/:id`  | `automation.manage` | Enable, disable, reprioritise.                    |
| `GET`    | `/automation/executions` | `automation.manage` | What fired, when, and what it did — newest first. |
| `GET`    | `/rewards/definitions`   | `reward.manage`     |                                                   |
| `POST`   | `/rewards/definitions`   | `reward.manage`     |                                                   |
| `POST`   | `/rewards/grants`        | `reward.manage`     | Grant by hand: `{ rewardCode, memberId }`.        |
| `DELETE` | `/rewards/grants/:id`    | `reward.manage`     | Revokes; the row stays.                           |
| `GET`    | `/rewards/me`            | `reward.view`       | The caller's grants, newest first.                |

## 6. Events

`RewardGranted`, `RewardRevoked`. Automation itself emits nothing — a rule that
emitted an event would be a rule that can trigger a rule (see §1).

## 7. Out of scope

- Scheduled/time-based triggers ("30 days after joining"). Every trigger here is
  an event that already happens. A time trigger needs a scheduler, which is the
  same carried gap as subscription renewal, rank evaluation and commission runs.
- Email, LINE and AI actions, until each has an adapter worth trusting.
- Fulfilment of physical rewards.
