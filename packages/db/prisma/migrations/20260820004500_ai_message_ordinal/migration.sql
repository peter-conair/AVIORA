-- Both messages of a turn are written in one transaction, so Postgres stamps
-- them with the SAME created_at (now() = transaction start). Ordering by that
-- alone is a tie, and the tie decided whether the model saw its own reply
-- before the question that prompted it. An explicit ordinal removes the guess.
ALTER TABLE "ai_messages" ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows: within a turn the user message always precedes the
-- assistant one, so created_at + role gives the historical order.
WITH ordered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY conversation_id
           ORDER BY created_at, CASE role WHEN 'user' THEN 0 ELSE 1 END, id
         ) AS rn
    FROM "ai_messages"
)
UPDATE "ai_messages" m
   SET "ordinal" = ordered.rn
  FROM ordered
 WHERE m.id = ordered.id;

DROP INDEX IF EXISTS "ai_messages_tenant_id_conversation_id_created_at_idx";
CREATE INDEX "ai_messages_tenant_id_conversation_id_ordinal_idx"
    ON "ai_messages" ("tenant_id", "conversation_id", "ordinal");
