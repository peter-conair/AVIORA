-- Name lists and scoring (docs/56).
--
-- Additive: every existing lead keeps working and simply appears on neither
-- list until somebody puts it on one.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS on_sponsor_list  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS on_customer_list boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scores           jsonb,
  ADD COLUMN IF NOT EXISTS sponsor_score    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_score   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jogger_prompt    text;

-- tenant_id first (docs/08 §43); the list flag next because a screen always
-- asks for one list, and the score last because that is the sort.
CREATE INDEX IF NOT EXISTS leads_tenant_sponsor_list_idx
  ON leads (tenant_id, on_sponsor_list, sponsor_score);
CREATE INDEX IF NOT EXISTS leads_tenant_customer_list_idx
  ON leads (tenant_id, on_customer_list, customer_score);
