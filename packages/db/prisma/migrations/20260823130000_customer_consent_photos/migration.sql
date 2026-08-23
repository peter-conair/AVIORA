-- Consent, and the photographs it permits (docs/65).

CREATE TABLE IF NOT EXISTS customer_consents (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  customer_id           uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  purpose               text NOT NULL,
  granted_at            timestamptz(6) NOT NULL DEFAULT now(),
  recorded_by_member_id uuid NOT NULL,
  revoked_at            timestamptz(6),
  note                  text
);
-- One row per purpose per customer: re-consenting after a withdrawal updates
-- the same row, so the history of the decision stays in one place.
CREATE UNIQUE INDEX IF NOT EXISTS customer_consents_customer_purpose_key
  ON customer_consents (customer_id, purpose);
CREATE INDEX IF NOT EXISTS customer_consents_tenant_customer_idx
  ON customer_consents (tenant_id, customer_id, revoked_at);

CREATE TABLE IF NOT EXISTS progress_photos (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  customer_id           uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  step_key              text NOT NULL,
  taken_at              timestamptz(6) NOT NULL DEFAULT now(),
  storage_key           text NOT NULL,
  content_type          text NOT NULL,
  byte_size             integer NOT NULL,
  uploaded_by_member_id uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS progress_photos_tenant_customer_idx
  ON progress_photos (tenant_id, customer_id, taken_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_consents','progress_photos']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aviora_app', t);
  END LOOP;
END $$;

-- Deliberately NO platform_access policy on either table (docs/65 §6).
-- The platform role reads across tenants for support; a customer consented to
-- their salesperson holding their photograph, not to the platform operator
-- being able to look at it.
