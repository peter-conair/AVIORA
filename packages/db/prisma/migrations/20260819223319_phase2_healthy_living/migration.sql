-- CreateTable
CREATE TABLE "health_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "lifestyle_notes" TEXT,
    "focus_goal_ids" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "health_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "habits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cadence" TEXT NOT NULL DEFAULT 'daily',
    "target_unit" TEXT,
    "target_value" DECIMAL(10,2),
    "status" TEXT NOT NULL DEFAULT 'active',
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "habits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "habit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "habit_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "log_date" DATE NOT NULL,
    "value" DECIMAL(10,2),
    "completed" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "habit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_metrics" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "measured_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_data_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "grantee_member_id" UUID NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'summary',
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "health_data_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "health_profiles_member_id_key" ON "health_profiles"("member_id");

-- CreateIndex
CREATE INDEX "health_profiles_tenant_id_member_id_idx" ON "health_profiles"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "habits_tenant_id_member_id_status_idx" ON "habits"("tenant_id", "member_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "habits_member_id_code_key" ON "habits"("member_id", "code");

-- CreateIndex
CREATE INDEX "habit_logs_tenant_id_member_id_log_date_idx" ON "habit_logs"("tenant_id", "member_id", "log_date");

-- CreateIndex
CREATE UNIQUE INDEX "habit_logs_habit_id_log_date_key" ON "habit_logs"("habit_id", "log_date");

-- CreateIndex
CREATE INDEX "health_metrics_tenant_id_member_id_metric_measured_on_idx" ON "health_metrics"("tenant_id", "member_id", "metric", "measured_on");

-- CreateIndex
CREATE UNIQUE INDEX "health_metrics_member_id_metric_measured_on_key" ON "health_metrics"("member_id", "metric", "measured_on");

-- CreateIndex
CREATE INDEX "health_data_grants_tenant_id_grantee_member_id_revoked_at_idx" ON "health_data_grants"("tenant_id", "grantee_member_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "health_data_grants_member_id_grantee_member_id_key" ON "health_data_grants"("member_id", "grantee_member_id");

-- AddForeignKey
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_habit_id_fkey" FOREIGN KEY ("habit_id") REFERENCES "habits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── RLS: health tables are strictly tenant-owned ──
-- Tenant isolation is the outer boundary; member-level privacy (SELF only,
-- unless the member granted access) is enforced in the application, because it
-- depends on the acting member, not just the tenant.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'health_profiles','habits','habit_logs','health_metrics','health_data_grants'
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
