-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "tax_label" TEXT,
ADD COLUMN     "tax_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tax_rate_basis_points" INTEGER;

-- CreateTable
CREATE TABLE "tenant_branding" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "app_name" TEXT,
    "logo_url" TEXT,
    "colors" JSONB,
    "font_family" TEXT,
    "landing" JSONB,
    "email_from_name" TEXT,
    "email_footer" TEXT,
    "hidden_features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_branding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_localisation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "default_locale" TEXT NOT NULL DEFAULT 'th',
    "supported_locales" TEXT[] DEFAULT ARRAY['th', 'en']::TEXT[],
    "currency" VARCHAR(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    "address_format" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_localisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "country" VARCHAR(2),
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_acceptances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" TEXT,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "region" TEXT,
    "rate_basis_points" INTEGER NOT NULL,
    "inclusive" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_branding_tenant_id_key" ON "tenant_branding"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_localisation_tenant_id_key" ON "tenant_localisation"("tenant_id");

-- CreateIndex
CREATE INDEX "legal_documents_tenant_id_kind_locale_idx" ON "legal_documents"("tenant_id", "kind", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "legal_documents_tenant_id_kind_locale_country_version_key" ON "legal_documents"("tenant_id", "kind", "locale", "country", "version");

-- CreateIndex
CREATE INDEX "legal_acceptances_tenant_id_accepted_at_idx" ON "legal_acceptances"("tenant_id", "accepted_at");

-- CreateIndex
CREATE UNIQUE INDEX "legal_acceptances_member_id_document_id_key" ON "legal_acceptances"("member_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rules_tenant_id_country_region_key" ON "tax_rules"("tenant_id", "country", "region");

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_branding','tenant_localisation','legal_documents','legal_acceptances','tax_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- A rate is a rate: no negatives, and nothing above 100%.
ALTER TABLE "tax_rules"
  ADD CONSTRAINT "tax_rate_sane" CHECK ("rate_basis_points" >= 0 AND "rate_basis_points" <= 10000);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aviora_app;
