-- Fix: after a SET LOCAL transaction ends, a custom GUC reads back as ''
-- (empty string), not NULL — casting '' to uuid errors. Treat '' as unset
-- so out-of-context sessions get default-deny (zero rows), not an error.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_settings',
    'tenant_memberships',
    'members',
    'roles',
    'role_permissions',
    'member_roles',
    'audit_logs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
