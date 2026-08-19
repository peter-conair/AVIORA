-- CreateTable
CREATE TABLE "communities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "team_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'team',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "author_member_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'post',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "author_member_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reactions" (
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'like',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reactions_pkey" PRIMARY KEY ("post_id","member_id","kind")
);

-- CreateTable
CREATE TABLE "challenges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "community_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "source_ref" TEXT,
    "target_value" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_participants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "challenge_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gamification_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "badge_code" TEXT,
    "badge_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gamification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "reference_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_badges" (
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "badge_code" TEXT NOT NULL,
    "badge_name" TEXT NOT NULL,
    "awarded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_badges_pkey" PRIMARY KEY ("member_id","badge_code")
);

-- CreateIndex
CREATE UNIQUE INDEX "communities_team_id_key" ON "communities"("team_id");

-- CreateIndex
CREATE INDEX "communities_tenant_id_team_id_idx" ON "communities"("tenant_id", "team_id");

-- CreateIndex
CREATE UNIQUE INDEX "communities_tenant_id_code_key" ON "communities"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "posts_tenant_id_community_id_pinned_created_at_idx" ON "posts"("tenant_id", "community_id", "pinned", "created_at");

-- CreateIndex
CREATE INDEX "comments_tenant_id_post_id_created_at_idx" ON "comments"("tenant_id", "post_id", "created_at");

-- CreateIndex
CREATE INDEX "reactions_tenant_id_post_id_idx" ON "reactions"("tenant_id", "post_id");

-- CreateIndex
CREATE INDEX "challenges_tenant_id_status_ends_on_idx" ON "challenges"("tenant_id", "status", "ends_on");

-- CreateIndex
CREATE UNIQUE INDEX "challenges_tenant_id_code_key" ON "challenges"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "challenge_participants_tenant_id_member_id_idx" ON "challenge_participants"("tenant_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_participants_challenge_id_member_id_key" ON "challenge_participants"("challenge_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "gamification_rules_tenant_id_event_name_key" ON "gamification_rules"("tenant_id", "event_name");

-- CreateIndex
CREATE INDEX "point_entries_tenant_id_member_id_created_at_idx" ON "point_entries"("tenant_id", "member_id", "created_at");

-- CreateIndex
CREATE INDEX "member_badges_tenant_id_member_id_idx" ON "member_badges"("tenant_id", "member_id");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_participants" ADD CONSTRAINT "challenge_participants_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── RLS: all tenant-owned ──
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'communities','posts','comments','reactions',
    'challenges','challenge_participants',
    'gamification_rules','point_entries','member_badges'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aviora_app;
