-- 0008 · Rol de autenticacion.
--
-- Hay dos operaciones que, por naturaleza, no pueden saber el inquilino:
--
--   · Iniciar sesion. Se busca al usuario por correo antes de saber a que
--     cuenta pertenece.
--   · Aceptar una invitacion. Se busca por el hash del token, y el token es lo
--     unico que trae quien lo acepta.
--
-- El alta de cuenta NO esta en esa lista: se resuelve pidiendo un uuidv7() a la
-- base, poniendolo en app.tenant_id y creando la cuenta dentro de su propio
-- contexto. Sin escape.
--
-- Este rol es de SOLO LECTURA y solo sobre las tablas de identidad. Igual que
-- el rol del relay (migracion 0006), el escape se hace con politicas acotadas
-- y no con BYPASSRLS, que se aplicaria a toda la base.
--
-- Que no pueda escribir es lo importante: si alguien encadenara una inyeccion
-- hasta este rol, podria enumerar usuarios pero no crear membresias ni
-- cambiar contrasenas.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmapp_auth') THEN
    CREATE ROLE crmapp_auth NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO crmapp_auth;
GRANT USAGE ON SCHEMA app TO crmapp_auth;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO crmapp_auth;

GRANT SELECT ON tenants     TO crmapp_auth;
GRANT SELECT ON users       TO crmapp_auth;
GRANT SELECT ON memberships TO crmapp_auth;
GRANT SELECT ON invitations TO crmapp_auth;

CREATE POLICY auth_lectura ON tenants     FOR SELECT TO crmapp_auth USING (true);
CREATE POLICY auth_lectura ON users       FOR SELECT TO crmapp_auth USING (true);
CREATE POLICY auth_lectura ON memberships FOR SELECT TO crmapp_auth USING (true);
CREATE POLICY auth_lectura ON invitations FOR SELECT TO crmapp_auth USING (true);
