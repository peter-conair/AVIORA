-- The tracking sheets (docs/59).
--
-- One engine, three sheets. The Follow Up Sheet, Diamond Check List and 6WNY
-- protocol differ only in their columns, and those columns name this business's
-- products — so they are tenant rows, not code.

CREATE TABLE IF NOT EXISTS tracker_templates (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  description  text,
  subject_type text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  "order"      integer NOT NULL DEFAULT 0,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at   timestamptz(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tracker_templates_tenant_code_key
  ON tracker_templates (tenant_id, code);
CREATE INDEX IF NOT EXISTS tracker_templates_tenant_active_idx
  ON tracker_templates (tenant_id, is_active, "order");

CREATE TABLE IF NOT EXISTS tracker_steps (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  template_id uuid NOT NULL REFERENCES tracker_templates(id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  stage_label text,
  "order"     integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS tracker_steps_template_key_key
  ON tracker_steps (template_id, key);
CREATE INDEX IF NOT EXISTS tracker_steps_tenant_template_order_idx
  ON tracker_steps (tenant_id, template_id, "order");

CREATE TABLE IF NOT EXISTS tracker_entries (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  template_id     uuid NOT NULL REFERENCES tracker_templates(id) ON DELETE CASCADE,
  subject_type    text NOT NULL,
  subject_id      uuid NOT NULL,
  owner_member_id uuid NOT NULL REFERENCES members(id),
  group_label     text,
  started_at      timestamptz(6) NOT NULL DEFAULT now(),
  completed_at    timestamptz(6),
  last_marked_at  timestamptz(6),
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  updated_at      timestamptz(6) NOT NULL DEFAULT now()
);
-- One row per person per sheet: two would let the same person be half-ticked
-- in two places and neither would be the truth.
CREATE UNIQUE INDEX IF NOT EXISTS tracker_entries_tenant_template_subject_key
  ON tracker_entries (tenant_id, template_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS tracker_entries_tenant_template_group_idx
  ON tracker_entries (tenant_id, template_id, group_label);
-- "who has stalled" sorts by last_marked_at inside one owner's book.
CREATE INDEX IF NOT EXISTS tracker_entries_tenant_owner_last_marked_idx
  ON tracker_entries (tenant_id, owner_member_id, last_marked_at);

CREATE TABLE IF NOT EXISTS tracker_marks (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  entry_id            uuid NOT NULL REFERENCES tracker_entries(id) ON DELETE CASCADE,
  step_id             uuid NOT NULL REFERENCES tracker_steps(id) ON DELETE CASCADE,
  marked_at           timestamptz(6) NOT NULL DEFAULT now(),
  marked_by_member_id uuid,
  note                text
);
-- Ticking twice is the same tick, not two.
CREATE UNIQUE INDEX IF NOT EXISTS tracker_marks_entry_step_key
  ON tracker_marks (entry_id, step_id);
CREATE INDEX IF NOT EXISTS tracker_marks_tenant_entry_idx
  ON tracker_marks (tenant_id, entry_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tracker_templates','tracker_steps','tracker_entries','tracker_marks']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY platform_access ON %I
      FOR SELECT USING (current_setting('app.platform', true) = 'true')$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aviora_app', t);
    EXECUTE format('GRANT SELECT ON %I TO aviora_platform', t);
  END LOOP;
END $$;
