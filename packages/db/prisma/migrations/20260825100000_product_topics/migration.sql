-- A product may hang off a TOPIC directly (docs/74 §6).
--
-- Until now the only path from the journey to a product ran through an
-- ingredient, which is right for a supplement and impossible for everything
-- else: a water filter, an air purifier and a frying pan contain no ingredient
-- and were therefore unreachable from any goal, however plainly they belong to
-- one.
--
-- This does NOT move products earlier in the journey. The rule docs/74 §5
-- states is that a product is never the BEGINNING — goal leads to topics, and
-- only then to products. That rule is intact; what changes is that the last
-- step no longer has to be an ingredient.
CREATE TABLE IF NOT EXISTS "product_topics" (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE,
  topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (product_id, topic_id)
);
CREATE INDEX IF NOT EXISTS "product_topics_topic_id_idx" ON "product_topics" ("topic_id");

-- Carries no tenant_id, exactly like product_ingredients: it only connects rows
-- the layered knowledge policies already gate, so it is readable and writable
-- through its parents.
ALTER TABLE "product_topics" ENABLE ROW LEVEL SECURITY;
CREATE POLICY join_open ON "product_topics" USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_topics" TO aviora_app;
GRANT SELECT ON "product_topics" TO aviora_platform;
