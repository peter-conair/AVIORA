-- Corporate wellness sponsorship (docs/45).

CREATE TABLE "sponsorship_pools" (
  "id"           UUID PRIMARY KEY,
  "tenant_id"    UUID NOT NULL,
  "code"         TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "plan_id"      UUID NOT NULL,
  "seats"        INTEGER NOT NULL,
  "sponsor_name" TEXT,
  "status"       TEXT NOT NULL DEFAULT 'active',
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "sponsorship_pools_tenant_id_code_key" UNIQUE ("tenant_id", "code"),
  -- A pool of zero seats is a pool nobody can join; a negative one is a bug
  -- that would otherwise show up as free capacity.
  CONSTRAINT "sponsorship_pool_seats_positive" CHECK ("seats" > 0)
);

CREATE TABLE "sponsored_seats" (
  "id"            UUID PRIMARY KEY,
  "tenant_id"     UUID NOT NULL,
  "pool_id"       UUID NOT NULL REFERENCES "sponsorship_pools"("id") ON DELETE CASCADE,
  "member_id"     UUID,
  "invitation_id" UUID,
  "assigned_at"   TIMESTAMPTZ(6),
  "released_at"   TIMESTAMPTZ(6),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL
);

CREATE INDEX "sponsored_seats_tenant_id_pool_id_released_at_idx"
  ON "sponsored_seats" ("tenant_id", "pool_id", "released_at");
CREATE INDEX "sponsored_seats_tenant_id_member_id_idx"
  ON "sponsored_seats" ("tenant_id", "member_id");

-- A member holds at most one ACTIVE seat, enforced here rather than by whichever
-- service remembers to check: two sponsors paying for one person is a billing
-- argument nobody can settle after the fact (docs/45 §2).
CREATE UNIQUE INDEX "sponsored_seats_one_active_per_member"
  ON "sponsored_seats" ("tenant_id", "member_id")
  WHERE "member_id" IS NOT NULL AND "released_at" IS NULL;

-- Tenant-owned, like everything a tenant can read (docs/04).
ALTER TABLE "sponsorship_pools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sponsorship_pools" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sponsorship_pools"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sponsored_seats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sponsored_seats" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sponsored_seats"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "sponsorship_pools" TO aviora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sponsored_seats" TO aviora_app;
