-- The column held a SEALED secret, not a hash, from the day it shipped: OIDC's
-- token exchange needs the secret back, and a hash cannot give it back. The
-- name was wrong, and a column name that lies about its contents is how the
-- next person stores a real hash there and breaks every federated login.
ALTER TABLE "tenant_identity_providers"
  RENAME COLUMN "client_secret_hash" TO "client_secret_encrypted";
