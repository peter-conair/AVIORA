-- CreateTable
CREATE TABLE "referral_relationships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "referrer_member_id" UUID NOT NULL,
    "referred_member_id" UUID NOT NULL,
    "relationship_type" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rank_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "requalify_window_days" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rank_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rank_qualifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rank_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "comparator" TEXT NOT NULL DEFAULT 'gte',
    "threshold" INTEGER NOT NULL,
    "window" TEXT NOT NULL DEFAULT 'lifetime',
    "params" JSONB,

    CONSTRAINT "rank_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rank_progress" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "rank_id" UUID,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "rank_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rank_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "rank_id" UUID NOT NULL,
    "achieved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lost_at" TIMESTAMPTZ(6),
    "reason" TEXT NOT NULL,

    CONSTRAINT "rank_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "referral_relationships_tenant_id_referrer_member_id_relatio_idx" ON "referral_relationships"("tenant_id", "referrer_member_id", "relationship_type");

-- CreateIndex
CREATE INDEX "referral_relationships_tenant_id_referred_member_id_relatio_idx" ON "referral_relationships"("tenant_id", "referred_member_id", "relationship_type");

-- CreateIndex
CREATE UNIQUE INDEX "rank_definitions_tenant_id_code_key" ON "rank_definitions"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "rank_definitions_tenant_id_level_key" ON "rank_definitions"("tenant_id", "level");

-- CreateIndex
CREATE INDEX "rank_qualifications_tenant_id_rank_id_idx" ON "rank_qualifications"("tenant_id", "rank_id");

-- CreateIndex
CREATE UNIQUE INDEX "rank_progress_tenant_id_member_id_key" ON "rank_progress"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "rank_history_tenant_id_member_id_achieved_at_idx" ON "rank_history"("tenant_id", "member_id", "achieved_at");

-- AddForeignKey
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_referrer_member_id_fkey" FOREIGN KEY ("referrer_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_referred_member_id_fkey" FOREIGN KEY ("referred_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rank_qualifications" ADD CONSTRAINT "rank_qualifications_rank_id_fkey" FOREIGN KEY ("rank_id") REFERENCES "rank_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rank_progress" ADD CONSTRAINT "rank_progress_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rank_progress" ADD CONSTRAINT "rank_progress_rank_id_fkey" FOREIGN KEY ("rank_id") REFERENCES "rank_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rank_history" ADD CONSTRAINT "rank_history_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rank_history" ADD CONSTRAINT "rank_history_rank_id_fkey" FOREIGN KEY ("rank_id") REFERENCES "rank_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Growth tables are strictly tenant-owned: a rank ladder and a referral graph
-- belong to one tenant and are never shared.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'referral_relationships','rank_definitions','rank_qualifications',
    'rank_progress','rank_history'
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

-- One ACTIVE relationship per (referred member, type): a member has one sponsor
-- at a time. Ended edges (effective_to set) stay for history, unconstrained.
CREATE UNIQUE INDEX "referral_active_one_per_type"
    ON "referral_relationships" ("tenant_id", "referred_member_id", "relationship_type")
 WHERE "effective_to" IS NULL;

-- A member cannot refer themselves.
ALTER TABLE "referral_relationships"
  ADD CONSTRAINT "referral_no_self" CHECK ("referrer_member_id" <> "referred_member_id");

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aviora_app;
