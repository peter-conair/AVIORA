-- A role for platform reads (docs/53).
--
-- Platform paths connected as aviora_owner, and Postgres exempts a table's
-- owner from its own policies even under FORCE ROW LEVEL SECURITY. So on those
-- paths there was no second layer: a mistake in a cross-tenant query had
-- nothing underneath it (docs/03 §4.1).
--
-- This adds a role that is NOT the owner and must ask to be treated as
-- platform. The role itself is created by `ensurePlatformRole()` alongside
-- aviora_app, because a password belongs in an env var and never in a
-- migration file.

DO $$
DECLARE t record;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aviora_platform') THEN
    CREATE ROLE aviora_platform NOLOGIN;
  END IF;

  -- One permissive policy per table that already has tenant_isolation. Policies
  -- are OR'd, so this widens access for THIS ROLE ONLY, and only inside a
  -- transaction that has declared itself.
  --
  -- `current_setting('app.platform', true) = 'true'` is the whole safeguard: a
  -- platform connection that forgets to declare sees zero rows rather than
  -- every tenant's. That is the same failure shape a tenant connection with no
  -- tenant already has, and it is what makes this an explicit entry point
  -- instead of an inherited privilege.
  FOR t IN
    SELECT c.relname
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE p.polname = 'tenant_isolation' AND n.nspname = 'public'
  LOOP
    EXECUTE format(
      'CREATE POLICY platform_access ON %I AS PERMISSIVE FOR ALL TO aviora_platform '
      'USING (current_setting(''app.platform'', true) = ''true'') '
      'WITH CHECK (current_setting(''app.platform'', true) = ''true'')',
      t.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aviora_platform', t.relname);
  END LOOP;

  -- Platform-scope tables carry no tenant_id and no tenant_isolation policy, so
  -- there is nothing for a policy to widen — but the role still needs to read
  -- them, because they are exactly what a platform view reports on.
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname IN ('domain_events','scheduled_job_runs','alert_states','tenants',
                         'users','processed_events','tenant_databases','_prisma_migrations')
  LOOP
    EXECUTE format('GRANT SELECT ON %I TO aviora_platform', t.relname);
  END LOOP;
END $$;

-- Sequences, so an INSERT through the platform role is possible where a policy
-- allows one.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO aviora_platform;
