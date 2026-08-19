-- AlterTable
ALTER TABLE "articles" ADD COLUMN     "search_text" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "translations" JSONB;

-- AlterTable
ALTER TABLE "health_goals" ADD COLUMN     "search_text" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "translations" JSONB;

-- AlterTable
ALTER TABLE "ingredients" ADD COLUMN     "search_text" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "translations" JSONB;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "search_text" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "translations" JSONB;

-- AlterTable
ALTER TABLE "topics" ADD COLUMN     "search_text" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "translations" JSONB;

-- search_text carries every language's searchable text for a row (base fields
-- plus each translation), so retrieval is language-agnostic without a separate
-- index per locale. It is maintained by the application on write.
CREATE INDEX health_goals_search_text_idx ON health_goals USING gin (to_tsvector('simple', search_text));
CREATE INDEX topics_search_text_idx ON topics USING gin (to_tsvector('simple', search_text));
CREATE INDEX ingredients_search_text_idx ON ingredients USING gin (to_tsvector('simple', search_text));
CREATE INDEX articles_search_text_idx ON articles USING gin (to_tsvector('simple', search_text));
CREATE INDEX products_search_text_idx ON products USING gin (to_tsvector('simple', search_text));
