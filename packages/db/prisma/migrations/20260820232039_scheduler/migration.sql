-- CreateTable
CREATE TABLE "scheduled_job_runs" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "tenant_id" UUID,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "outcome" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_job_runs_job_scheduled_for_idx" ON "scheduled_job_runs"("job", "scheduled_for");

-- CreateIndex
CREATE INDEX "scheduled_job_runs_status_scheduled_for_idx" ON "scheduled_job_runs"("status", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_job_runs_job_tenant_id_scheduled_for_key" ON "scheduled_job_runs"("job", "tenant_id", "scheduled_for");

-- scheduled_job_runs is PLATFORM machinery, like tenant_databases: it records
-- what the platform ran across every tenant, and a tenant must not be able to
-- read another's rows or forge its own. It is deliberately NOT tenant-owned,
-- so it carries no tenant_isolation policy — and the app role may only read it.
REVOKE INSERT, UPDATE, DELETE ON "scheduled_job_runs" FROM aviora_app;

-- A run belongs to an occurrence; a job name is not free text sprawl.
ALTER TABLE "scheduled_job_runs"
  ADD CONSTRAINT "scheduled_job_name" CHECK ("job" ~ '^[a-z][a-z0-9_.]{2,40}$');
