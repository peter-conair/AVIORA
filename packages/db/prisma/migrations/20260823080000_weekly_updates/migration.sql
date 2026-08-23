-- The weekly review sheet (docs/61). Words only — every number is computed.

CREATE TABLE IF NOT EXISTS weekly_updates (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  member_id        uuid NOT NULL REFERENCES members(id),
  week_of          date NOT NULL,
  progression_note text,
  prospect_note    text,
  plan_note        text,
  question_note    text,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS weekly_updates_tenant_member_week_key
  ON weekly_updates (tenant_id, member_id, week_of);
CREATE INDEX IF NOT EXISTS weekly_updates_tenant_week_idx
  ON weekly_updates (tenant_id, week_of);

ALTER TABLE weekly_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON weekly_updates
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY platform_access ON weekly_updates
  FOR SELECT USING (current_setting('app.platform', true) = 'true');
GRANT SELECT, INSERT, UPDATE, DELETE ON weekly_updates TO aviora_app;
GRANT SELECT ON weekly_updates TO aviora_platform;
