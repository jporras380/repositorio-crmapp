-- 0010 · Politica de visibilidad de conversaciones entre agentes (ADR-008).
--
-- Se guarda como DATO desde hoy aunque el valor por defecto sea "todos ven
-- todo": anadir la politica despues obligaria a una migracion de
-- comportamiento con agentes ya acostumbrados. Una columna ahora cuesta nada.
--
-- Se aplica en la API, solo al rol `agent`. No es una politica RLS a
-- proposito: RLS aisla inquilinos; los permisos dentro de un inquilino son de
-- la aplicacion (ARCH §6).

ALTER TABLE tenants
  ADD COLUMN conversation_visibility text NOT NULL DEFAULT 'all'
    CHECK (conversation_visibility IN ('all', 'team', 'assigned'));

COMMENT ON COLUMN tenants.conversation_visibility IS
  'Que ven los agentes: all (todo), team (suyas + sin asignar + de su equipo), assigned (solo suyas). Roles superiores ven todo.';
