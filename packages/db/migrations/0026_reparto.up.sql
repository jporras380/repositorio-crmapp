-- 0026 · Reparto automático de conversaciones.
--
-- ## Por qué «el menos ocupado» y no turno rotatorio
--
-- El turno rotatorio (A, B, C, A…) reparte llegadas, no trabajo: si A cierra
-- sus conversaciones en cinco minutos y B tiene veinte abiertas, B sigue
-- recibiendo igual. Asignar a quien tiene menos conversaciones abiertas
-- reparte carga, que es lo que un equipo nota. Con empate, al azar.
--
-- ## Apagado por defecto
--
-- Asignar solo cambia quién ve qué cuando la visibilidad es «solo las suyas»
-- (ADR-008). Activarlo en una cuenta que ya trabaja sin reparto le cambiaría
-- el día a su equipo sin avisar.
--
-- Aditiva: dos columnas con valor por defecto.

ALTER TABLE tenants
  ADD COLUMN auto_assignment text NOT NULL DEFAULT 'off'
    CHECK (auto_assignment IN ('off', 'least_busy'));

COMMENT ON COLUMN tenants.auto_assignment IS
  'Reparto de conversaciones nuevas: off (nadie las asigna solas) o least_busy (al miembro con menos conversaciones abiertas).';

-- Quién entra en el reparto. Por defecto todos: en un hotel pequeño también
-- atiende la dueña. Se desmarca a quien no deba recibir (contabilidad, etc.).
ALTER TABLE memberships
  ADD COLUMN accepts_assignments boolean NOT NULL DEFAULT true;
