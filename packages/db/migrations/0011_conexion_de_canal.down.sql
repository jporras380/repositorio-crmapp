-- Reversa de 0011.
DROP POLICY IF EXISTS auth_lectura ON channel_secrets;
DROP POLICY IF EXISTS auth_lectura ON channel_accounts;
REVOKE ALL ON channel_accounts, channel_secrets FROM crmapp_auth;
ALTER TABLE channel_accounts DROP COLUMN IF EXISTS provider_account_id;
