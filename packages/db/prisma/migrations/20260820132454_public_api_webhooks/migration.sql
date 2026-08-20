-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "secret_hash" TEXT NOT NULL,
    "events" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response_code" INTEGER,
    "error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_endpoints_tenant_id_status_idx" ON "webhook_endpoints"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "webhook_deliveries_tenant_id_created_at_idx" ON "webhook_deliveries"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_id_event_id_key" ON "webhook_deliveries"("endpoint_id", "event_id");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_revoked_at_idx" ON "api_keys"("tenant_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_tenant_id_prefix_key" ON "api_keys"("tenant_id", "prefix");

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_endpoints','webhook_deliveries','api_keys'] LOOP
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

-- A webhook must be sent somewhere the platform will actually reach, and
-- plaintext http would put a signed payload on the wire in the clear.
ALTER TABLE "webhook_endpoints"
  ADD CONSTRAINT "webhook_url_https" CHECK ("url" LIKE 'https://%');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aviora_app;
