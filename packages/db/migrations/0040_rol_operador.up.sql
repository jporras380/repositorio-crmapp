-- 0040 · Rol del operador de la plataforma.
--
-- La consola del operador tiene que ver TODAS las cuentas a la vez: cuál está
-- por vencer, cuál consume de más, a cuál le debemos un comprobante. Eso es,
-- por definición, leer a través del aislamiento que sostiene el producto.
--
-- ## Por qué un rol y no una bandera de sesión
--
-- La alternativa era una variable de sesión —«si `app.operador` está puesto,
-- deja leerlo todo»— y es más frágil: cualquier camino que consiga ejecutar un
-- `set_config` desbloquea la base entera. Un ROL no se cambia desde dentro de
-- una consulta. Es el mismo razonamiento que llevó al rol de autenticación
-- (0008) y al del relay (0006); esto sigue el patrón en vez de inventar otro.
--
-- ## Por qué NO lleva BYPASSRLS
--
-- `BYPASSRLS` se aplicaría a toda la base y para siempre. Aquí el escape son
-- políticas nombradas sobre una lista corta de tablas: lo que no esté en esta
-- migración, el operador no lo ve. Añadir una tabla a la lista es un cambio
-- que se lee en una revisión.
--
-- ## Lo que el operador NO puede ver, y es deliberado
--
-- `conversations`, `messages`, `contacts`, `reservations`, `internal_notes`.
-- Nada de la correspondencia con huéspedes. Para cobrar y para saber si una
-- cuenta va bien hacen falta cifras, no los mensajes de nadie.
--
-- Y es de SOLO LECTURA: si alguien encadenara una inyección hasta este rol,
-- podría contar conversaciones ajenas, no tocarlas. Lo único que el operador
-- escribe —el comprobante de un pago— pasa por el rol de aplicación entrando
-- en el contexto del inquilino (0039), no por aquí.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmapp_operador') THEN
    CREATE ROLE crmapp_operador NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO crmapp_operador;
GRANT USAGE ON SCHEMA app TO crmapp_operador;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO crmapp_operador;

-- Quién es quién y qué paga.
GRANT SELECT ON tenants               TO crmapp_operador;
GRANT SELECT ON users                 TO crmapp_operador;
GRANT SELECT ON memberships           TO crmapp_operador;
GRANT SELECT ON plans                 TO crmapp_operador;
GRANT SELECT ON subscriptions         TO crmapp_operador;
GRANT SELECT ON subscription_payments TO crmapp_operador;
-- Si la cuenta funciona: cuánto consume y si sus canales reciben.
GRANT SELECT ON usage_rollups         TO crmapp_operador;
GRANT SELECT ON channel_accounts      TO crmapp_operador;

CREATE POLICY operador_lectura ON tenants               FOR SELECT TO crmapp_operador USING (true);
CREATE POLICY operador_lectura ON users                 FOR SELECT TO crmapp_operador USING (true);
CREATE POLICY operador_lectura ON memberships           FOR SELECT TO crmapp_operador USING (true);
CREATE POLICY operador_lectura ON subscriptions         FOR SELECT TO crmapp_operador USING (true);
CREATE POLICY operador_lectura ON subscription_payments FOR SELECT TO crmapp_operador USING (true);
CREATE POLICY operador_lectura ON usage_rollups         FOR SELECT TO crmapp_operador USING (true);
CREATE POLICY operador_lectura ON channel_accounts      FOR SELECT TO crmapp_operador USING (true);

-- `plans` es catálogo de la plataforma, no de un inquilino: no lleva RLS y
-- basta el GRANT.

COMMENT ON ROLE crmapp_operador IS
  'Consola del operador (0040). Solo lectura, solo facturación y salud. No ve conversaciones.';
