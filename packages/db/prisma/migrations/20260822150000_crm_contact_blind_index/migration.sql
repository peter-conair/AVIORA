-- CRM contact blind index (docs/54, docs/55).
--
-- Additive and reversible: nothing existing is read, rewritten or dropped. The
-- columns hold HMAC digests of the normalised contact values, which is what
-- makes an exact-match lookup survive the day `email` and `phone` become
-- ciphertext. Until that day they sit alongside the plaintext and serve the
-- duplicate check.
--
-- Backfill is NOT here: computing a digest needs the index key, which SQL does
-- not have. `pnpm --filter @aviora/db db:backfill-crm-bidx` fills them.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS email_bidx text,
  ADD COLUMN IF NOT EXISTS phone_bidx text;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS email_bidx text,
  ADD COLUMN IF NOT EXISTS phone_bidx text;

-- tenant_id leads, because every CRM lookup already sits inside one tenant and
-- an index the query cannot enter from the left is one Postgres will not use
-- (docs/08 §43).
CREATE INDEX IF NOT EXISTS leads_tenant_id_email_bidx_idx     ON leads     (tenant_id, email_bidx);
CREATE INDEX IF NOT EXISTS leads_tenant_id_phone_bidx_idx     ON leads     (tenant_id, phone_bidx);
CREATE INDEX IF NOT EXISTS customers_tenant_id_email_bidx_idx ON customers (tenant_id, email_bidx);
CREATE INDEX IF NOT EXISTS customers_tenant_id_phone_bidx_idx ON customers (tenant_id, phone_bidx);
