# 15 — MVP User Journeys (Vertical Slices)

> Three end-to-end vertical slices prove the MVP (spec §72–§74). Each is written as a concrete journey: actors, steps, screens, API calls, and events. Implementation proceeds slice by slice; a slice is done when its journey passes as an automated E2E test plus the listed assertions.
>
> Conventions: all endpoints under `/api/v1`; errors use `{error:{code,message,details,request_id}}`; list endpoints use cursor pagination; events are PascalCase via outbox → BullMQ. TenantContext resolves subdomain → custom domain → `X-Tenant-ID` → JWT claim.
>
> Status: Approved · Last updated: 2026-08-19 · Source: spec §72–§74

---

## Slice 1 — Tenant Genesis to Member Dashboard (spec §72)

**Proves**: Platform → Tenant → Membership → Member → Team → Goal → Learning → Dashboard, with isolation, entitlements, and events working end to end.

**Actors**: Platform Admin (Pat) · Tenant Admin/Owner (Ann) · Team Leader (Lena) · Member (Mia).

### Journey

| #   | Actor  | Action                                                                                             | Screen (apps/web)                         | API                                                                                      | Events emitted                                         |
| --- | ------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Pat    | Logs into platform console                                                                         | `/platform/sign-in`                       | `POST /auth/login`                                                                       | —                                                      |
| 2   | Pat    | Creates tenant "Vitalia Wellness", slug `vitalia`                                                  | `/platform/tenants/new`                   | `POST /platform/tenants`                                                                 | `TenantCreated`                                        |
| 3   | Pat    | Configures tenant (language th/en, timezone Asia/Bangkok, currency THB, branding)                  | `/platform/tenants/:id/settings`          | `PATCH /platform/tenants/:id`                                                            | —                                                      |
| 4   | Pat    | Creates tenant owner account for Ann (invite email)                                                | `/platform/tenants/:id/admins`            | `POST /platform/tenants/:id/owners`                                                      | `MemberRegistered` (Ann, role Tenant Owner)            |
| 5   | Ann    | Accepts invite, sets password, logs in at `vitalia.aviora.app`                                     | `/sign-in`, tenant switcher shows Vitalia | `POST /auth/accept-invite`, `POST /auth/login`                                           | —                                                      |
| 6   | Ann    | Creates membership plan "Starter" (free, entitlements: `course.access`, `goal.create`, `ai.coach`) | `/admin/membership-plans/new`             | `POST /membership-plans`                                                                 | —                                                      |
| 7   | Ann    | Creates Team A "Bangkok Hub" (root team)                                                           | `/admin/teams/new`                        | `POST /teams`                                                                            | `TeamCreated`                                          |
| 8   | Ann    | Invites Lena and assigns her as Primary Leader of Team A                                           | `/admin/teams/:id/leaders`                | `POST /teams/:id/leaders` (body: member_id, leadership_role, is_primary, effective_from) | `LeaderAssigned`                                       |
| 9   | Ann    | Sends member invite to Mia (plan: Starter, team: A)                                                | `/admin/members/invite`                   | `POST /members/invitations`                                                              | —                                                      |
| 10  | Mia    | Opens invite link, registers (th locale)                                                           | `/register?invite=…`                      | `POST /auth/register`                                                                    | `MemberRegistered`                                     |
| 11  | system | Activates Starter membership; resolves entitlements                                                | — (async worker + sync activation)        | `POST /memberships` (internal on invite acceptance)                                      | `MembershipActivated`                                  |
| 12  | system | Adds Mia to Team A                                                                                 | —                                         | internal via invitation payload → TeamMembership insert                                  | `MemberJoinedTeam`                                     |
| 13  | Mia    | Completes onboarding profile step                                                                  | `/onboarding`                             | `PATCH /members/me/profile`                                                              | `MemberOnboardingStepCompleted`                        |
| 14  | Mia    | Creates goal "Sleep 7 hours nightly" (category: health, quarterly)                                 | `/goals/new`                              | `POST /members/me/goals`                                                                 | `GoalCreated`                                          |
| 15  | Mia    | Starts course "Healthy Living Foundations"                                                         | `/learning/courses/:id`                   | `POST /learning/courses/:id/enroll`                                                      | `CourseStarted`                                        |
| 16  | Mia    | Completes lesson 1 task                                                                            | `/learning/courses/:id/lessons/:lid`      | `POST /learning/progress`                                                                | `CourseCompleted` (when final lesson) / progress event |
| 17  | Mia    | Views her dashboard: goal progress + learning progress                                             | `/dashboard`                              | `GET /members/me/dashboard`                                                              | —                                                      |
| 18  | Lena   | Views team dashboard: 1 direct member, learning progress rolled up                                 | `/teams/:id/dashboard`                    | `GET /teams/:id/dashboard`                                                               | —                                                      |
| 19  | Mia    | Asks Basic AI Assistant "what should I focus on this week?"                                        | `/assistant`                              | `POST /ai/conversations` + `POST /ai/conversations/:id/messages`                         | — (AIUsage recorded)                                   |

### Slice 1 assertions

- Registering Mia with the same email in a second tenant creates a **second TenantMembership on one User** — the tenant switcher lists both.
- All rows created carry `tenant_id` = Vitalia; an RLS probe as another tenant's context returns zero rows.
- Every write above appears in `audit_log` with `request_id`, before/after where applicable.
- Notification worker consumed `MemberRegistered` → welcome in-app + email; `GoalCreated` → confirmation notification.
- AI assistant answers using only Mia's own data and tenant-allowed knowledge; `ai_usage` row records tokens/cost for the tenant.
- Mia without entitlement `team.create` receives `403 {error:{code:"PERMISSION_DENIED"}}` on `POST /teams`.

---

## Slice 2 — Recursive Teams & Scoped Permissions (spec §73)

**Proves**: unlimited nesting via closure table, independent leadership, scope-aware authorization, metric roll-up, preserved history, tenant boundaries.

**Actors**: Tenant Admin (Ann) · Leader A (Lena, root) · Leader A1 (Boon) · Leader A1.1 (Chai) · Leader A1.1.1 (Dara) · members in each team.

### Setup steps

| #   | Actor   | Action                                                                                                                                                                                       | API                                      | Events                |
| --- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------- |
| 1   | Ann     | Creates hierarchy: Team A → A1 → A1.1 → A1.1.1 (`parent_team_id` chained)                                                                                                                    | `POST /teams` ×3 (with `parent_team_id`) | `TeamCreated` ×3      |
| 2   | Ann     | Assigns Boon, Chai, Dara as primary leaders of A1, A1.1, A1.1.1                                                                                                                              | `POST /teams/:id/leaders` ×3             | `LeaderAssigned` ×3   |
| 3   | Ann     | Grants Lena role "Senior Leader" carrying `team.member.view` + `team.analytics.view` @ `DESCENDANT_TEAMS`; leaders Boon/Chai/Dara hold "Team Leader" role with the same keys @ `DIRECT_TEAM` | `POST /roles`, `POST /members/:id/roles` | —                     |
| 4   | various | Members join each level (TeamMembership; one member joins both A1 and A1.1.1 to prove multi-team)                                                                                            | invitation flow as Slice 1               | `MemberJoinedTeam` ×n |

Closure-table state after setup (per spec §15): `A→A:0, A→A1:1, A→A1.1:2, A→A1.1.1:3, A1→A1.1:1, …` — verified by `GET /teams/:idA/descendants`.

### Permission assertions (must pass as automated tests)

| Assertion                                                                  | Call                                       | Expected                                |
| -------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| Lena (root, DESCENDANT_TEAMS) lists A1.1.1 members                         | `GET /teams/:idA111/members` as Lena       | `200`, members returned                 |
| Lena views 4-level descendant list                                         | `GET /teams/:idA/descendants`              | `200`, A1, A1.1, A1.1.1 with depths 1–3 |
| Chai (leader of A1.1, DIRECT_TEAM) views own team                          | `GET /teams/:idA11/members` as Chai        | `200`                                   |
| Chai views **ancestor** A1 members                                         | `GET /teams/:idA1/members` as Chai         | `403 PERMISSION_DENIED`                 |
| Chai views **sibling/descendant-of-sibling** teams he's not authorized for | `GET /teams/:idOther/members`              | `403`                                   |
| Dara views A1.1.1 dashboard                                                | `GET /teams/:idA111/dashboard`             | `200`, direct metrics only              |
| Ann (TENANT_ALL) views everything in tenant                                | any team endpoint                          | `200`                                   |
| Cross-tenant probe: leader from Tenant B calls any Vitalia team id         | `GET /teams/:id/...` with Tenant B context | `404 NOT_FOUND` (existence not leaked)  |

### Metric roll-up assertions

- `GET /teams/:idA/dashboard` shows `direct_members` (members of A only) **and** `organization_members` (A + all descendants, deduplicated by member) — separate fields per spec §20; same split for learning progress.
- Adding a member to A1.1.1 increments A's `organization_members` but not `direct_members`.

### History assertions

- Ann replaces Chai with a new leader: old `TeamLeadership` row gets `effective_to = now()`, new row `effective_from = now()`; `GET /teams/:id/leaders?include_history=true` shows both; `LeaderAssigned` emitted; audit rows exist.
- Ann moves Team A1.1.1 under A1 (`PATCH /teams/:id` with new `parent_team_id`): closure table is rebuilt for the subtree, previous relationships remain reconstructable from audit + effective-dated records; roll-up metrics reflect the move; no history destroyed.

---

## Slice 3 — Knowledge-to-Product Journey (spec §74)

**Proves**: knowledge before product, brand neutrality, the graph path `Healthy Living Goal → Topic → Article → Ingredient → Product`.

**Actors**: Tenant Admin (Ann, curates content) · Member (Mia, consumes journey).

### Content setup (Ann, or seeded)

| #   | Action                                                                                            | API                                  | Notes                                                     |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| 1   | Create HealthGoal "Better Sleep"                                                                  | `POST /health-goals`                 | knowledge anchor entity                                   |
| 2   | Create Topic "Sleep Hygiene", link to goal                                                        | `POST /knowledge/topics` (+ mapping) | HealthGoal ↔ Topic                                        |
| 3   | Publish Article "7 Evidence-Based Sleep Hygiene Practices" mapped to topic + ingredient           | `POST /knowledge/articles`           | Article ↔ Topic, Article ↔ Ingredient                     |
| 4   | Create Ingredient "Magnesium" with evidence reference                                             | `POST /knowledge/ingredients`        | Ingredient ↔ Evidence; educational context + safety notes |
| 5   | Create Brands "Brand A", "Brand B" and one magnesium product under each, mapped to the ingredient | `POST /brands`, `POST /products`     | proves brand neutrality — two brands, zero schema changes |

### Member journey (Mia)

| #   | Action                                                                                                                                                                                                         | Screen                       | API                                       | Events                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------- | -------------------------- |
| 1   | Opens Healthy Living section, picks goal "Better Sleep"                                                                                                                                                        | `/health-goals`              | `GET /health-goals`                       | —                          |
| 2   | Sees topics for the goal; opens "Sleep Hygiene"                                                                                                                                                                | `/health-goals/:id`          | `GET /health-goals/:id/topics`            | —                          |
| 3   | Reads the article (th or en)                                                                                                                                                                                   | `/knowledge/articles/:slug`  | `GET /knowledge/articles/:id`             | (view tracked → analytics) |
| 4   | Article surfaces ingredient card "Magnesium" with evidence context + safety note                                                                                                                               | same screen                  | `GET /knowledge/ingredients/:id`          | —                          |
| 5   | Ingredient page lists **related products from multiple brands**, ranked after knowledge, each with Product Intelligence (ingredients, evidence context, source URL, last verified, safety notes, alternatives) | `/knowledge/ingredients/:id` | `GET /knowledge/ingredients/:id/products` | —                          |
| 6   | Searches "sleep" — results rank knowledge (goal, topic, articles) **before** products                                                                                                                          | `/search`                    | `GET /knowledge/search?q=sleep`           | —                          |
| 7   | (Optional, MVP) Opens a product detail — read-only, external/affiliate link only, no cart                                                                                                                      | `/products/:id`              | `GET /products/:id`                       | —                          |

### Slice 3 assertions

- **Brand neutrality**: adding Brand C + product via API succeeds with no schema/code change; it appears in step 5 automatically.
- **Knowledge before product**: search ranking test — for query "sleep", all knowledge results precede all product results; the journey has no entry point that starts at a product grid.
- **Safety context**: ingredient and product responses include `safety_notes` and evidence context fields; no diagnostic or medical-claim language in seeded content (content guideline test).
- **Scopes**: an article marked tenant-private in Tenant B is never returned in Vitalia's context (isolation test on knowledge scope: Global vs Tenant vs Private).
- **AI tie-in**: asking the Basic AI Assistant about better sleep retrieves only authorized knowledge (authorization enforced before retrieval) and cites tenant-visible content.

---

## Cross-Slice Exit Criteria

All three slices green in CI (API integration + Playwright E2E, th and en locales, mobile viewport) + the [Definition of MVP Done checklist](./14-mvp-scope.md#3-definition-of-mvp-done--acceptance-checklist-spec-84-verbatim) fully checked = MVP complete.
