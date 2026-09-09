-- Reversa de 0002.
--
-- La politica `tenant_members` de `users` referencia `memberships`, asi que
-- PostgreSQL no deja soltar `memberships` mientras exista. Una politica es una
-- dependencia como cualquier otra, y es facil olvidarlo porque no se ve en el
-- diagrama de claves foraneas.
DROP POLICY IF EXISTS tenant_members ON users;

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS business_hours;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;
