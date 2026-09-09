-- 0011 · Conexion BYO de canales (ADR-004).
--
-- 1. `provider_account_id`: el identificador de la cuenta padre en el
--    proveedor. En WhatsApp es la WABA (hace falta para las plantillas); en
--    Instagram sera el id de la cuenta de negocio. No es secreto.
--
-- 2. Lectura de cuentas y secretos por el rol `crmapp_auth`. Un webhook llega
--    SIN inquilino: solo trae el phone_number_id. Resolver a que cuenta
--    pertenece —y con que app secret verificar su firma— exige una lectura
--    que cruza inquilinos, igual que iniciar sesion (migracion 0008). Mismo
--    patron: politica acotada, solo lectura, nunca BYPASSRLS.
--
--    Que ese rol pueda LEER secretos cifrados no es una fuga: sin la clave
--    maestra del proceso son bytes. Y no puede escribirlos ni borrarlos.

ALTER TABLE channel_accounts ADD COLUMN provider_account_id text;
COMMENT ON COLUMN channel_accounts.provider_account_id IS
  'Cuenta padre en el proveedor: WABA en WhatsApp, cuenta de negocio en Instagram.';

GRANT SELECT ON channel_accounts TO crmapp_auth;
GRANT SELECT ON channel_secrets  TO crmapp_auth;
CREATE POLICY auth_lectura ON channel_accounts FOR SELECT TO crmapp_auth USING (true);
CREATE POLICY auth_lectura ON channel_secrets  FOR SELECT TO crmapp_auth USING (true);
