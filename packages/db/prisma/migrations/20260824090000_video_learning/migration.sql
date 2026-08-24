-- Video lessons, and who is allowed to see them yet (docs/73).
--
-- Three tables and one column. `learning_assignments` is a SEQUENCING table,
-- not a grant table: dropping every row in it must leave no member able to see
-- anything they could not see before (docs/73 §1).

ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS release_policy text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS release_rule   jsonb;

-- Open by default, so a tenant that never uses this feature is unaffected by
-- its existence. A shut-by-default library would silently hide every existing
-- course the moment this migration ran.
ALTER TABLE courses
  ADD CONSTRAINT courses_release_policy_check
  CHECK (release_policy IN ('open', 'on_assignment'));

CREATE TABLE IF NOT EXISTS lesson_assets (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  lesson_id        uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('video', 'captions', 'thumbnail')),
  -- '*' rather than NULL: Postgres treats NULLs as distinct, so a nullable
  -- locale would let one lesson hold two thumbnails and the unique key below
  -- would not notice.
  locale           text NOT NULL DEFAULT '*',
  storage_key      text NOT NULL,
  content_type     text NOT NULL,
  byte_size        integer NOT NULL CHECK (byte_size >= 0),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  created_at       timestamptz(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lesson_assets_lesson_kind_locale_key
  ON lesson_assets (lesson_id, kind, locale);
CREATE INDEX IF NOT EXISTS lesson_assets_tenant_lesson_idx
  ON lesson_assets (tenant_id, lesson_id);

CREATE TABLE IF NOT EXISTS learning_assignments (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  member_id             uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  course_id             uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  state                 text NOT NULL DEFAULT 'assigned' CHECK (state IN ('assigned', 'held')),
  source                text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'rule')),
  assigned_by_member_id uuid NOT NULL,
  assigned_at           timestamptz(6) NOT NULL DEFAULT now(),
  due_at                timestamptz(6),
  reason                text,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  updated_at            timestamptz(6) NOT NULL DEFAULT now(),
  -- A hold the member cannot see the reason for is how this feature turns into
  -- a way of keeping somebody dependent (docs/73 §5). The database is where
  -- that stays true regardless of which route wrote the row.
  CONSTRAINT learning_assignments_held_needs_reason
    CHECK (state <> 'held' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_assignments_member_course_key
  ON learning_assignments (member_id, course_id);
CREATE INDEX IF NOT EXISTS learning_assignments_tenant_course_state_idx
  ON learning_assignments (tenant_id, course_id, state);

CREATE TABLE IF NOT EXISTS lesson_views (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  member_id        uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  lesson_id        uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position_seconds integer NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  watched_seconds  integer NOT NULL DEFAULT 0 CHECK (watched_seconds >= 0),
  completed_at     timestamptz(6),
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lesson_views_member_lesson_key
  ON lesson_views (member_id, lesson_id);
CREATE INDEX IF NOT EXISTS lesson_views_tenant_member_idx
  ON lesson_views (tenant_id, member_id);

ALTER TABLE lesson_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lesson_assets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY platform_access ON lesson_assets
  FOR SELECT USING (current_setting('app.platform', true) = 'true');
GRANT SELECT, INSERT, UPDATE, DELETE ON lesson_assets TO aviora_app;
GRANT SELECT ON lesson_assets TO aviora_platform;

ALTER TABLE learning_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON learning_assignments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY platform_access ON learning_assignments
  FOR SELECT USING (current_setting('app.platform', true) = 'true');
GRANT SELECT, INSERT, UPDATE, DELETE ON learning_assignments TO aviora_app;
GRANT SELECT ON learning_assignments TO aviora_platform;

ALTER TABLE lesson_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_views FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lesson_views
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY platform_access ON lesson_views
  FOR SELECT USING (current_setting('app.platform', true) = 'true');
GRANT SELECT, INSERT, UPDATE, DELETE ON lesson_views TO aviora_app;
GRANT SELECT ON lesson_views TO aviora_platform;
