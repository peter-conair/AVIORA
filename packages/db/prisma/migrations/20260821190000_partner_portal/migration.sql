-- Partner portal (docs/46).

CREATE TABLE "partners" (
  "id"            UUID PRIMARY KEY,
  "tenant_id"     UUID NOT NULL,
  "code"          TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "contact_email" TEXT,
  "status"        TEXT NOT NULL DEFAULT 'active',
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "partners_tenant_id_code_key" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "partner_users" (
  "id"         UUID PRIMARY KEY,
  "tenant_id"  UUID NOT NULL,
  "partner_id" UUID NOT NULL REFERENCES "partners"("id") ON DELETE CASCADE,
  "user_id"    UUID NOT NULL,
  "status"     TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  -- One person belongs to at most one partner per tenant. Without this, the
  -- guard's "resolve the partner from the token's user" has more than one
  -- answer, and a principal with two identities is a principal with none.
  CONSTRAINT "partner_users_tenant_id_user_id_key" UNIQUE ("tenant_id", "user_id")
);
CREATE INDEX "partner_users_tenant_id_partner_id_idx" ON "partner_users" ("tenant_id", "partner_id");

CREATE TABLE "partner_referrals" (
  "id"            UUID PRIMARY KEY,
  "tenant_id"     UUID NOT NULL,
  "partner_id"    UUID NOT NULL REFERENCES "partners"("id") ON DELETE CASCADE,
  -- Null while the invitation is outstanding: a row is written when the
  -- partner INVITES, and the member id arrives when they accept. Postgres
  -- treats NULLs as distinct, so the unique key below still allows many
  -- outstanding invitations while permitting only one partner per member.
  "member_id"     UUID,
  "invitation_id" UUID,
  "joined_at"     TIMESTAMPTZ(6),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- One member, one partner: two partners claiming the same person is an
  -- argument about money nobody can settle after the fact.
  CONSTRAINT "partner_referrals_tenant_id_member_id_key" UNIQUE ("tenant_id", "member_id")
);
CREATE INDEX "partner_referrals_tenant_id_partner_id_idx"
  ON "partner_referrals" ("tenant_id", "partner_id");

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partners','partner_users','partner_referrals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aviora_app', t);
  END LOOP;
END $$;
