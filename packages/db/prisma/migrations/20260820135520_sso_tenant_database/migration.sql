-- CreateTable
CREATE TABLE "tenant_identity_providers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'oidc',
    "issuer" TEXT NOT NULL,
    "discovery_url" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_hash" TEXT NOT NULL,
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "jit_provisioning" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_identity_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_logins" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "redirect_to" TEXT,
    "consumed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "claims" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_logins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_databases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'shared',
    "dsn_secret_ref" TEXT,
    "migrated_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_databases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_identity_providers_tenant_id_key" ON "tenant_identity_providers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sso_logins_state_key" ON "sso_logins"("state");

-- CreateIndex
CREATE INDEX "sso_logins_tenant_id_created_at_idx" ON "sso_logins"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_databases_tenant_id_key" ON "tenant_databases"("tenant_id");

-- AddForeignKey
ALTER TABLE "sso_logins" ADD CONSTRAINT "sso_logins_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "tenant_identity_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- tenant_identity_providers and sso_logins are tenant-owned. tenant_databases
-- is PLATFORM scope: it says where a tenant lives, and a tenant must not be
-- able to read or change that, so it is deliberately NOT tenant-readable.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_identity_providers','sso_logins'] LOOP
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

-- The app role can read where tenants live but never write it: relocation is
-- an operator action, run deliberately, not something a request can trigger.
REVOKE INSERT, UPDATE, DELETE ON "tenant_databases" FROM aviora_app;

-- A discovery URL that is not https is a login flow somebody can stand in the
-- middle of.
ALTER TABLE "tenant_identity_providers"
  ADD CONSTRAINT "sso_discovery_https" CHECK ("discovery_url" LIKE 'https://%');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aviora_app;
REVOKE INSERT, UPDATE, DELETE ON "tenant_databases" FROM aviora_app;
