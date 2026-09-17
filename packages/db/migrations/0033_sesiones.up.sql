-- 0033 · Sesiones que se pueden cerrar.
--
-- Hasta aquí el JWT no tenía estado: se firmaba, se entregaba y valía hasta
-- caducar. Dos consecuencias que no se ven hasta que hacen falta:
--
-- 1. **Un token robado no se puede anular.** Ni cambiando la contraseña.
-- 2. **Nadie sabe desde dónde está entrando.** Ni el propio dueño de la
--    cuenta, que es quien reconocería un sitio raro.
--
-- Esta tabla es lo que convierte «cerrar sesión» en algo que de verdad cierra.
--
-- ## El precio, dicho
--
-- Una lectura por petición autenticada. Es el coste de poder revocar: un token
-- sin estado es más rápido justamente porque nadie le pregunta a nadie si
-- sigue valiendo. Se paga con un índice por clave primaria, y `last_seen_at`
-- se escribe como mucho una vez por minuto para no castigar la fila.

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Lo que el dueño de la cuenta reconoce o no reconoce.
  ip              text,
  user_agent      text,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  -- Cerrada a mano. No se borra la fila: el historial de accesos es lo que
  -- deja ver «alguien entró desde Lima el martes», y borrarlo lo esconde.
  revoked_at      timestamptz,
  revoked_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_del_usuario_idx ON sessions (user_id, created_at DESC);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
SELECT app.enable_tenant_rls('sessions');
