-- A composite UNIQUE(tenant_id, code) does NOT constrain global rows, because
-- SQL treats NULLs as distinct: two global rows could share a code. Replace it
-- with a matched pair of partial unique indexes — one for global knowledge,
-- one per tenant (docs/08 §conventions).

DROP INDEX IF EXISTS "health_goals_tenant_id_code_key";
DROP INDEX IF EXISTS "topics_tenant_id_code_key";
DROP INDEX IF EXISTS "ingredients_tenant_id_code_key";
DROP INDEX IF EXISTS "articles_tenant_id_slug_key";
DROP INDEX IF EXISTS "brands_tenant_id_code_key";
DROP INDEX IF EXISTS "products_tenant_id_code_key";

CREATE UNIQUE INDEX health_goals_global_code_key ON health_goals (code) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX health_goals_tenant_code_key ON health_goals (tenant_id, code) WHERE tenant_id IS NOT NULL;

CREATE UNIQUE INDEX topics_global_code_key ON topics (code) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX topics_tenant_code_key ON topics (tenant_id, code) WHERE tenant_id IS NOT NULL;

CREATE UNIQUE INDEX ingredients_global_code_key ON ingredients (code) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX ingredients_tenant_code_key ON ingredients (tenant_id, code) WHERE tenant_id IS NOT NULL;

CREATE UNIQUE INDEX articles_global_slug_key ON articles (slug) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX articles_tenant_slug_key ON articles (tenant_id, slug) WHERE tenant_id IS NOT NULL;

CREATE UNIQUE INDEX brands_global_code_key ON brands (code) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX brands_tenant_code_key ON brands (tenant_id, code) WHERE tenant_id IS NOT NULL;

CREATE UNIQUE INDEX products_global_code_key ON products (code) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX products_tenant_code_key ON products (tenant_id, code) WHERE tenant_id IS NOT NULL;
