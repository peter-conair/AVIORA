-- The customer index card, and its twelve-month grid (docs/66).

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS external_code         text,
  ADD COLUMN IF NOT EXISTS membership_expires_at date,
  ADD COLUMN IF NOT EXISTS birth_date            date,
  -- Named for what it holds. A column called `id_number` containing ciphertext
  -- is how somebody later writes plaintext into it and nobody notices.
  ADD COLUMN IF NOT EXISTS id_number_encrypted   text,
  ADD COLUMN IF NOT EXISTS note                  text;

CREATE TABLE IF NOT EXISTS customer_month_orders (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  year                integer NOT NULL,
  month               integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  note                text,
  marked_by_member_id uuid NOT NULL,
  created_at          timestamptz(6) NOT NULL DEFAULT now()
);
-- One row per month per customer; ticking twice is the same tick.
CREATE UNIQUE INDEX IF NOT EXISTS customer_month_orders_customer_year_month_key
  ON customer_month_orders (customer_id, year, month);
CREATE INDEX IF NOT EXISTS customer_month_orders_tenant_customer_year_idx
  ON customer_month_orders (tenant_id, customer_id, year);

ALTER TABLE customer_month_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_month_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_month_orders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY platform_access ON customer_month_orders
  FOR SELECT USING (current_setting('app.platform', true) = 'true');
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_month_orders TO aviora_app;
GRANT SELECT ON customer_month_orders TO aviora_platform;
