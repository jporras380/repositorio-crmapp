-- Reversa de 0008. No se hace DROP ROLE: los roles son del cluster.
DROP POLICY IF EXISTS auth_lectura ON invitations;
DROP POLICY IF EXISTS auth_lectura ON memberships;
DROP POLICY IF EXISTS auth_lectura ON users;
DROP POLICY IF EXISTS auth_lectura ON tenants;
REVOKE ALL ON tenants, users, memberships, invitations FROM crmapp_auth;
