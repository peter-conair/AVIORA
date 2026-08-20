-- CreateTable
CREATE TABLE "compensation_relationships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "upline_member_id" UUID NOT NULL,
    "downline_member_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "compensation_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bonus_type" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "payout" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" VARCHAR(3) NOT NULL,
    "total_minor" INTEGER NOT NULL DEFAULT 0,
    "entry_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(6),

    CONSTRAINT "commission_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "bonus_type" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "basis" JSONB NOT NULL,

    CONSTRAINT "commission_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "compensation_relationships_tenant_id_upline_member_id_idx" ON "compensation_relationships"("tenant_id", "upline_member_id");

-- CreateIndex
CREATE INDEX "compensation_relationships_tenant_id_downline_member_id_idx" ON "compensation_relationships"("tenant_id", "downline_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_plans_tenant_id_code_key" ON "compensation_plans"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "compensation_rules_tenant_id_plan_id_priority_idx" ON "compensation_rules"("tenant_id", "plan_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_rules_tenant_id_plan_id_code_key" ON "compensation_rules"("tenant_id", "plan_id", "code");

-- CreateIndex
CREATE INDEX "commission_runs_tenant_id_status_idx" ON "commission_runs"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commission_runs_tenant_id_plan_id_period_start_period_end_key" ON "commission_runs"("tenant_id", "plan_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "commission_entries_tenant_id_member_id_idx" ON "commission_entries"("tenant_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "commission_entries_run_id_member_id_rule_id_key" ON "commission_entries"("run_id", "member_id", "rule_id");

-- AddForeignKey
ALTER TABLE "compensation_relationships" ADD CONSTRAINT "compensation_relationships_upline_member_id_fkey" FOREIGN KEY ("upline_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_relationships" ADD CONSTRAINT "compensation_relationships_downline_member_id_fkey" FOREIGN KEY ("downline_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_rules" ADD CONSTRAINT "compensation_rules_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "compensation_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_runs" ADD CONSTRAINT "commission_runs_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "compensation_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "commission_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "compensation_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'compensation_relationships','compensation_plans','compensation_rules',
    'commission_runs','commission_entries'
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

-- One active upline at a time: a member is paid under exactly one person, and
-- ended placements stay for history.
CREATE UNIQUE INDEX "compensation_active_one_upline"
    ON "compensation_relationships" ("tenant_id", "downline_member_id")
 WHERE "effective_to" IS NULL;

ALTER TABLE "compensation_relationships"
  ADD CONSTRAINT "compensation_no_self" CHECK ("upline_member_id" <> "downline_member_id");

-- Money never goes backwards through a commission entry.
ALTER TABLE "commission_entries"
  ADD CONSTRAINT "commission_amount_non_negative" CHECK ("amount_minor" >= 0);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aviora_app;
