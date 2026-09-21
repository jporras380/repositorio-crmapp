-- 0042 · Modo soporte: el cliente deja entrar, y solo un rato.
--
-- Hasta ahora el operador de la plataforma veía cifras de todas las cuentas
-- (0040) y nada más: ni una conversación. Eso hace defendible que exista la
-- consola, y no se toca.
--
-- Pero cuando un cliente escribe «no me llegan los mensajes», mirar cifras no
-- alcanza. Hace falta ver SU bandeja. Y eso son conversaciones de huéspedes,
-- con sus teléfonos y sus fechas.
--
-- ## Las cuatro condiciones, y por qué cada una
--
-- 1. **Lo autoriza el cliente.** No hay forma de que el operador se conceda
--    acceso a sí mismo: pide, y alguien de la cuenta aprueba. Un permiso que
--    uno se da solo no es un permiso, es una llave maestra.
-- 2. **Caduca solo.** El acceso lleva hora de fin y no hay manera de dejarlo
--    abierto «hasta que se acuerde de cerrarlo». Lo que se olvida, se queda.
-- 3. **Es de SOLO LECTURA**, y lo garantiza PostgreSQL. El rol `crmapp_soporte`
--    no tiene INSERT ni UPDATE ni DELETE sobre nada. Un soporte que puede
--    escribir puede romper, y entonces nadie sabe si el fallo era del cliente
--    o de quien fue a ayudarle.
-- 4. **Queda en la auditoría del cliente.** Quién pidió entrar, quién aprobó,
--    cuándo y por qué. El cliente puede mirarlo sin preguntarle a nadie.
--
-- ## Por qué las políticas de inquilino no hay que escribirlas otra vez
--
-- `tenant_isolation` (0001) no lleva cláusula `TO`, así que se aplica a
-- cualquier rol. Al rol de soporte le basta el GRANT de SELECT: la política
-- ya existente lo encierra en el inquilino que esté puesto en el contexto.

CREATE TABLE support_grants (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Quién pide entrar. Es un usuario de la plataforma, no del inquilino.
  requested_by uuid        NOT NULL REFERENCES users (id),
  -- Por qué. Obligatorio: «necesito entrar» no es un motivo que el cliente
  -- pueda valorar, y es lo único que tiene para decidir.
  reason       text        NOT NULL CHECK (length(btrim(reason)) >= 10),
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- Quién de la cuenta lo aprobó. NULL mientras está pendiente.
  approved_by  uuid REFERENCES users (id),
  approved_at  timestamptz,
  -- Hora a la que deja de valer. Se fija al aprobar, nunca al pedir: el plazo
  -- lo decide quien abre la puerta, no quien llama.
  expires_at   timestamptz,
  -- Cerrado a mano antes de tiempo. El cliente puede cortar cuando quiera.
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Una sola solicitud PENDIENTE por cuenta: dos a la vez solo confunden a
-- quien tiene que aprobarlas, y no hay ningún caso real con dos.
--
-- El índice no puede cubrir también «aprobada y todavía viva», porque eso
-- exige comparar con `now()` y PostgreSQL no admite funciones volátiles en el
-- predicado de un índice. Tampoco hace falta: dos permisos aprobados a la vez
-- dan el mismo acceso que uno, y el que caduque antes no quita nada.
CREATE UNIQUE INDEX support_grants_una_pendiente_idx
  ON support_grants (tenant_id)
  WHERE approved_at IS NULL AND revoked_at IS NULL;

SELECT app.enable_tenant_rls('support_grants');

-- El operador ve y crea solicitudes; aprobarlas no puede, que es el punto.
GRANT SELECT, INSERT ON support_grants TO crmapp_operador;
CREATE POLICY operador_soporte ON support_grants
  FOR SELECT TO crmapp_operador USING (true);
CREATE POLICY operador_pide ON support_grants
  FOR INSERT TO crmapp_operador
  WITH CHECK (approved_by IS NULL AND approved_at IS NULL AND expires_at IS NULL);

-- ---------------------------------------------------------------------------
-- El rol de soporte: mira la cuenta del cliente y no puede tocar nada.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmapp_soporte') THEN
    CREATE ROLE crmapp_soporte NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO crmapp_soporte;
GRANT USAGE ON SCHEMA app TO crmapp_soporte;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO crmapp_soporte;

-- Lo que hace falta para diagnosticar «no me llega» o «no se envía»: el hilo,
-- el estado de cada mensaje con su error, de quién es, y cómo están los
-- canales y los bots. Ni una tabla más.
GRANT SELECT ON conversations    TO crmapp_soporte;
GRANT SELECT ON messages         TO crmapp_soporte;
GRANT SELECT ON contacts         TO crmapp_soporte;
GRANT SELECT ON contact_identities TO crmapp_soporte;
GRANT SELECT ON channel_accounts TO crmapp_soporte;
GRANT SELECT ON media_assets     TO crmapp_soporte;
GRANT SELECT ON flow_runs        TO crmapp_soporte;
GRANT SELECT ON flow_run_steps   TO crmapp_soporte;
GRANT SELECT ON support_grants   TO crmapp_soporte;

-- Sin políticas nuevas: `tenant_isolation` no lleva `TO`, así que ya encierra
-- a este rol en el inquilino que ponga el contexto. Y como no tiene INSERT ni
-- UPDATE, el `WITH CHECK` de esa política nunca llega a evaluarse.

COMMENT ON ROLE crmapp_soporte IS
  'Modo soporte (0042). SOLO LECTURA, dentro de un inquilino y solo con un permiso vivo.';
