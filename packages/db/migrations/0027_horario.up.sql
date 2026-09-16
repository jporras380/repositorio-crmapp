-- 0027 · Horario de atención y aviso fuera de horario.
--
-- `business_hours` existe desde la fase 0 (0002) sin usarla nadie: tiene
-- `timezone` y `schedule`. Aquí se le añade lo que faltaba para que sirva —el
-- aviso automático— y se fija la FORMA del horario, que hasta hoy era un
-- `jsonb` vacío sin contrato:
--
--   {"1": [["09:00","13:00"], ["15:00","20:00"]], "6": [["09:00","13:00"]]}
--
-- Clave: día ISO (1 = lunes … 7 = domingo). Un día que no aparece está
-- cerrado. Los tramos son hora local del hotel, con su `timezone`: Barranca no
-- es UTC, y el servidor puede estar en cualquier sitio.
--
-- ## Por qué el aviso se guarda por conversación
--
-- Sin marca, cada mensaje de una persona a las 11 de la noche recibiría otro
-- aviso: diez mensajes, diez avisos. `out_of_hours_reply_at` guarda cuándo se
-- le avisó por última vez, y solo se vuelve a avisar pasadas unas horas.
--
-- Aditiva. Sin filas nuevas: sin horario configurado no cambia nada.

ALTER TABLE business_hours
  -- Aviso automático cuando escriben fuera de horario. Apagado por defecto.
  ADD COLUMN auto_reply_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_reply_text text NOT NULL DEFAULT ''
    CHECK (char_length(auto_reply_text) <= 1000);

-- Un horario por cuenta (el general) y, si algún día hay equipos, uno por
-- equipo. `NULLS NOT DISTINCT`: dos horarios generales serían ambiguos.
CREATE UNIQUE INDEX business_hours_por_equipo_uq
  ON business_hours (tenant_id, team_id) NULLS NOT DISTINCT;

ALTER TABLE conversations
  ADD COLUMN out_of_hours_reply_at timestamptz;

COMMENT ON COLUMN conversations.out_of_hours_reply_at IS
  'Última vez que se envió el aviso de fuera de horario en esta conversación. Evita repetirlo en cada mensaje.';
