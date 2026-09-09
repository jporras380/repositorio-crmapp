-- 0006 · Rol del relay del outbox.
--
-- El relay tiene un problema que el resto del sistema no tiene: necesita leer
-- las filas de TODOS los inquilinos. Es lo contrario de lo que hace RLS.
--
-- Hay dos formas de resolverlo y la elección importa:
--
--   (a) Dar BYPASSRLS al rol. Funciona, pero es un atributo de rol que se
--       aplica a TODA la base: ese rol dejaría de estar aislado en cualquier
--       tabla, no solo en `outbox`. Un escape que se concede una vez y luego
--       nadie recuerda que existe.
--
--   (b) Una política específica para el rol, solo sobre `outbox`. El escape
--       queda acotado a la tabla que lo necesita y es visible en el catálogo:
--       `\d outbox` lo muestra.
--
-- Se elige (b). El coste es que hay que añadir una política por cada tabla
-- que el relay necesite en el futuro — y eso es precisamente lo que se quiere,
-- porque obliga a decidirlo cada vez en lugar de heredarlo.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmapp_relay') THEN
    CREATE ROLE crmapp_relay NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO crmapp_relay;
GRANT USAGE ON SCHEMA app TO crmapp_relay;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO crmapp_relay;

-- SELECT y UPDATE, no INSERT ni DELETE: el relay publica y marca, nunca crea
-- ni borra eventos. Quien escribe en el outbox es la transaccion de negocio.
GRANT SELECT, UPDATE ON outbox TO crmapp_relay;

CREATE POLICY relay_todo ON outbox
  TO crmapp_relay
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY relay_todo ON outbox IS
  'El relay ve todos los inquilinos. Escape acotado a esta tabla, deliberadamente no BYPASSRLS.';
