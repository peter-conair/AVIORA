# 37 — Team Knowledge Contract (Sprint 18)

> Spec §46 (AI context), §50 (authorization before retrieval), docs/14 §3 row
> **16** — the one MVP row still open. It reads: _"Team-scoped knowledge does
> not exist yet, so there is nothing team-level for the assistant to respect."_
> This sprint makes it exist, and makes the assistant respect it.

## 1. An article is global, tenant, or team

`Article.tenant_id` already says global (null) or tenant. This adds
`Article.team_id`:

```
tenant_id = NULL, team_id = NULL   platform knowledge — everyone
tenant_id = T,    team_id = NULL   the tenant's knowledge — everyone in T
tenant_id = T,    team_id = X      X's knowledge — see §2
```

`team_id` without `tenant_id` is refused: a team belongs to a tenant, and a row
claiming otherwise is a row nobody can scope.

## 2. Reading goes UP the tree; writing goes DOWN it

This is the part worth stating twice, because the two directions look alike and
mean opposite things.

**Reading.** An article attached to team X is readable by members of X **and by
members of every team beneath X**. A regional playbook should reach the branches
under that region without being copied into each one. So for a member in team Y,
the readable articles are those attached to Y or to any **ancestor** of Y.

**Writing.** A leader may attach knowledge to the teams they lead and, with
`DESCENDANT_TEAMS`, everything under them. That is exactly what
`TeamScopeService.accessibleTeamIds` already computes, so this sprint adds no
second answer to "which teams may this person act on".

A member who leads nothing still reads their team's knowledge. Reading is
membership; writing is leadership. Confusing the two would either hide a team's
own handbook from the team, or let any member publish to it.

## 3. Authorization happens before retrieval — not after

Spec §50, and the reason this row was left open rather than faked. The
assistant does not filter results it has already seen: `KnowledgeService.search`
resolves the caller's readable team set and puts it **in the query**. There is
no code path on which an article the member cannot read is loaded into memory,
ranked, summarised, or cited.

The failure this prevents is specific and easy to picture: a member of one team
asks a question, and the answer quotes a rival branch's pricing playbook —
complete with a citation, which makes it look authorised. The test for this is
the most important one in the sprint, and it asserts on the **cited ids**, not
on the prose.

## 4. Nothing leaks through the side doors

The same rule binds every route that can return an article, because a knowledge
model with one guarded door and three open ones is not guarded:

| Route                           | Behaviour                                                       |
| ------------------------------- | --------------------------------------------------------------- |
| `GET /knowledge/search`         | Team articles the caller may read; others are not in the result |
| `GET /knowledge/articles/:slug` | 404 for an article the caller may not read — not 403            |
| `POST /ai/ask`                  | Retrieval is the same scoped call; citations cannot exceed it   |

404 rather than 403 on the article route is deliberate: 403 confirms the article
exists, and "there is a document here you may not see" is itself information
about another team.

## 5. Publishing

| Method  | Path                           | Permission              | Notes                                     |
| ------- | ------------------------------ | ----------------------- | ----------------------------------------- |
| `POST`  | `/knowledge/team-articles`     | `knowledge.team.manage` | `{ teamId, slug, title, body, summary? }` |
| `PATCH` | `/knowledge/team-articles/:id` | `knowledge.team.manage` | Edit or unpublish.                        |
| `GET`   | `/knowledge/team-articles`     | `knowledge.team.manage` | What this leader has published.           |

`knowledge.team.manage` is granted to owners at `TENANT_ALL` and to leaders at
`DESCENDANT_TEAMS`. Publishing to a team outside the caller's scope is refused
with the reason.

## 6. What this sprint refuses

- **No per-member article grants.** A grant table is a second permission system,
  and the team tree already expresses who should see what.
- **No embeddings or vector search.** Retrieval stays the term search that
  exists. Scope is the subject here; ranking is a separate argument, and mixing
  them would let a ranking change quietly alter who can see what.
- **No cross-team sharing links.** "Share this with team B as well" is a real
  request and a real design — many-to-many, with its own audit story. One team
  per article until somebody needs the second.
