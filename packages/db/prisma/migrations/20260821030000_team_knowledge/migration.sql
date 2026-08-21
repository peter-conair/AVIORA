-- Team knowledge (docs/37).
--
-- `team_id` narrows an article from the whole tenant to one team and everything
-- beneath it. Row-level security still does what it always did — it keeps one
-- tenant's articles away from another — but it cannot express the team rule:
-- the readable set depends on the CALLER's team membership walked up the
-- closure table, and there is no session variable that carries it. Team scope
-- is therefore enforced in the query the service builds (docs/37 §3), never by
-- filtering rows that were already fetched.
ALTER TABLE "articles" ADD COLUMN "team_id" UUID;

-- A team belongs to a tenant. An article naming a team but no tenant is a row
-- nobody can scope, so the database refuses it rather than trusting every
-- future writer to remember.
ALTER TABLE "articles"
  ADD CONSTRAINT "article_team_requires_tenant"
  CHECK ("team_id" IS NULL OR "tenant_id" IS NOT NULL);

ALTER TABLE "articles"
  ADD CONSTRAINT "articles_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;

CREATE INDEX "articles_tenant_id_team_id_status_idx"
  ON "articles" ("tenant_id", "team_id", "status");
