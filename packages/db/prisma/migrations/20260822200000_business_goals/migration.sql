-- The monthly goal sheet (docs/58).

CREATE TABLE IF NOT EXISTS business_goals (
  id                        uuid PRIMARY KEY,
  tenant_id                 uuid NOT NULL,
  member_id                 uuid NOT NULL REFERENCES members(id),
  month                     date NOT NULL,
  short_term                text,
  mid_term                  text,
  long_term                 text,
  life_goal                 text,
  volume_target_minor       integer,
  new_partners_target       integer,
  develop_customers_target  integer,
  develop_partners_target   integer,
  develop_customers_actual  integer NOT NULL DEFAULT 0,
  develop_partners_actual   integer NOT NULL DEFAULT 0,
  created_at                timestamptz(6) NOT NULL DEFAULT now(),
  updated_at                timestamptz(6) NOT NULL DEFAULT now()
);

-- One sheet per member per month: writing a second one silently would leave
-- two different answers to "what was the goal", and the weekly update would
-- pick whichever it found first.
CREATE UNIQUE INDEX IF NOT EXISTS business_goals_tenant_member_month_key
  ON business_goals (tenant_id, member_id, month);
CREATE INDEX IF NOT EXISTS business_goals_tenant_month_idx
  ON business_goals (tenant_id, month);

ALTER TABLE business_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_goals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_goals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- docs/53: the platform role reads across tenants, never writes.
CREATE POLICY platform_access ON business_goals
  FOR SELECT USING (current_setting('app.platform', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON business_goals TO aviora_app;
GRANT SELECT ON business_goals TO aviora_platform;
