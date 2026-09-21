-- Reversa de 0040. La consola del operador deja de poder leer; no se pierde
-- ningún dato, solo el permiso para verlos.
DROP POLICY IF EXISTS operador_lectura ON channel_accounts;
DROP POLICY IF EXISTS operador_lectura ON usage_rollups;
DROP POLICY IF EXISTS operador_lectura ON subscription_payments;
DROP POLICY IF EXISTS operador_lectura ON subscriptions;
DROP POLICY IF EXISTS operador_lectura ON memberships;
DROP POLICY IF EXISTS operador_lectura ON users;
DROP POLICY IF EXISTS operador_lectura ON tenants;

REVOKE ALL ON tenants, users, memberships, plans, subscriptions,
              subscription_payments, usage_rollups, channel_accounts
  FROM crmapp_operador;
REVOKE ALL ON SCHEMA public, app FROM crmapp_operador;

-- El rol no se borra: puede tener objetos o concesiones en otra base del
-- clúster, y un DROP ROLE que falla a medias deja la migración rota.
