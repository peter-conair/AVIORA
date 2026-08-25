-- Catalogue ingest (docs/74): a second system may write the GLOBAL knowledge
-- catalogue — brands, products, and the ingredient links that make a product
-- reachable — through the public API.
--
-- Three things this needs that did not exist: a way for a product row to say
-- who owns it, a key that belongs to no tenant, and a record of writes already
-- performed so a retry answers the same thing twice.

-- ── 1. A product row names its writer ────────────────────────────────────────
-- NULL means curated here (the seed, or by hand). An ingest names itself and
-- refuses rows it does not own, so a hand-written safety note cannot be erased
-- by the next sync of a product that happens to share its code.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "source" text;
CREATE INDEX IF NOT EXISTS "products_source_idx" ON "products" ("source") WHERE "source" IS NOT NULL;

-- ── 2. Platform-scope API keys ───────────────────────────────────────────────
-- NOT a nullable `api_keys.tenant_id`: that column is NOT NULL because a tenant
-- key belongs to exactly one tenant, the RLS policy is written against it, and
-- a schema meta-test asserts it. A key belonging to no tenant is a different
-- thing, so it lives in a different table — the same choice `tenant_databases`
-- and `scheduled_job_runs` made.
CREATE TABLE IF NOT EXISTS "platform_api_keys" (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  prefix        text NOT NULL,
  hash          text NOT NULL,
  scopes        text[] NOT NULL,
  created_by    uuid,
  last_used_at  timestamptz(6),
  expires_at    timestamptz(6),
  revoked_at    timestamptz(6),
  created_at    timestamptz(6) NOT NULL DEFAULT now()
);
-- Unique across the whole table, not per tenant: there is no tenant to scope it
-- to, and the guard finds a key by its prefix alone.
CREATE UNIQUE INDEX IF NOT EXISTS "platform_api_keys_prefix_key" ON "platform_api_keys" ("prefix");
CREATE INDEX IF NOT EXISTS "platform_api_keys_revoked_at_idx" ON "platform_api_keys" ("revoked_at");

-- Deliberately NO grant to aviora_app or aviora_platform. The table holds key
-- hashes and belongs to no tenant; the guard reads it as the owner. A table with
-- no policy AND no grant cannot leak through a policy somebody forgets to write.
REVOKE ALL ON "platform_api_keys" FROM aviora_app;
REVOKE ALL ON "platform_api_keys" FROM aviora_platform;

-- ── 3. Idempotency records ───────────────────────────────────────────────────
-- The ingest is already idempotent by its natural key (a SKU twice is one
-- product). This makes the ANSWER idempotent too: a caller whose connection
-- dropped mid-response retries and learns what the first attempt did.
CREATE TABLE IF NOT EXISTS "idempotency_records" (
  id            uuid PRIMARY KEY,
  caller_id     uuid NOT NULL,
  route         text NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer NOT NULL,
  response      jsonb NOT NULL,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  expires_at    timestamptz(6) NOT NULL
);
-- One record per caller per route per key. The caller is part of it because two
-- integrations may pick the same key string and neither is wrong.
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_records_caller_id_route_key_key"
  ON "idempotency_records" ("caller_id", "route", "key");
CREATE INDEX IF NOT EXISTS "idempotency_records_expires_at_idx"
  ON "idempotency_records" ("expires_at");

REVOKE ALL ON "idempotency_records" FROM aviora_app;
REVOKE ALL ON "idempotency_records" FROM aviora_platform;
