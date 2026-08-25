-- A picture of the thing (docs/74 §7).
--
-- The knowledge catalogue was text-only until now, and for a shop that would be
-- a deliberate restraint. This is not a shop: it is a place members read and
-- talk, and "which of these is the one on my shelf" is a question a paragraph
-- answers badly and a photograph answers instantly.
--
-- `url` is where the picture lives at the SOURCE. `stored_path` is our own copy,
-- and is NULL until somebody mirrors it — two columns rather than one because
-- the difference matters: a URL we do not own can go away without warning, and
-- a row that cannot tell you which kind it is holding cannot be audited for it.
CREATE TABLE IF NOT EXISTS "product_images" (
  id          uuid PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE,
  url         text NOT NULL,
  stored_path text,
  alt         text,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz(6) NOT NULL DEFAULT now()
);
-- The same picture twice is one picture; the source is what identifies it.
CREATE UNIQUE INDEX IF NOT EXISTS "product_images_product_id_url_key"
  ON "product_images" ("product_id", "url");
CREATE INDEX IF NOT EXISTS "product_images_product_id_position_idx"
  ON "product_images" ("product_id", "position");

-- Carries no tenant_id, like every other table that only connects rows the
-- layered knowledge policies already gate.
ALTER TABLE "product_images" ENABLE ROW LEVEL SECURITY;
CREATE POLICY join_open ON "product_images" USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_images" TO aviora_app;
GRANT SELECT ON "product_images" TO aviora_platform;
