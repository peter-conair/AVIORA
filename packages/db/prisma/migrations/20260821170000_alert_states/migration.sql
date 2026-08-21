-- Alert state (docs/42 §3).
--
-- One row per check, remembering what it last saw, so an email goes out when a
-- check STARTS firing and when it STOPS — not on every sweep. Re-sending the
-- same alert every five minutes is how people build inbox rules that hide the
-- one that matters.
CREATE TABLE "alert_states" (
  "check"            TEXT PRIMARY KEY,
  "firing"           BOOLEAN NOT NULL DEFAULT false,
  "value"            TEXT,
  "firing_since"     TIMESTAMPTZ(6),
  "last_notified_at" TIMESTAMPTZ(6),
  "checked_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Platform scope, exactly like scheduled_job_runs: this is the platform's own
-- health across every tenant. It carries no tenant_id and therefore no
-- tenant_isolation policy, and the app role may read it but never write it —
-- an alert a tenant could clear is not an alert.
ALTER TABLE "alert_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_read ON "alert_states" FOR SELECT USING (true);
GRANT SELECT ON "alert_states" TO aviora_app;
REVOKE INSERT, UPDATE, DELETE ON "alert_states" FROM aviora_app;

-- A check name is a stable identifier, not free text: alert history that
-- changes shape every release is history nobody can read.
ALTER TABLE "alert_states"
  ADD CONSTRAINT "alert_check_name" CHECK ("check" ~ '^[a-z][a-z0-9_.]{2,40}$');
