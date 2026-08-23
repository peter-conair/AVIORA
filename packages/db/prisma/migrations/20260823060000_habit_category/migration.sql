-- Business habits alongside health habits (docs/60).
--
-- Existing rows default to 'health', which is what they are: the column exists
-- so that business activity a coach is meant to see never gets resolved by the
-- same query as health data a member was promised privacy over (docs/13).

ALTER TABLE habits ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'health';
CREATE INDEX IF NOT EXISTS habits_tenant_member_category_idx
  ON habits (tenant_id, member_id, category);
