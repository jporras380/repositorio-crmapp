ALTER TABLE conversations DROP COLUMN IF EXISTS human_reply_at;

-- Reversa de 0017.
--
-- Las ejecuciones dormidas en una `pausa` no caben en el esquema anterior. No
-- se borran —son historia de conversaciones reales— sino que se **cancelan con
-- motivo**: al volver atrás, el nodo `pausa` ya no existe en el motor y
-- despertarlas llevaría a un paso que no se sabe ejecutar. Dejarlas dormidas
-- para siempre sería peor que cerrarlas diciendo por qué.
UPDATE flow_runs
   SET status = 'cancelled',
       error = 'revertido_pausa',
       wait_for = NULL,
       wait_until = NULL,
       ended_at = now(),
       updated_at = now()
 WHERE wait_for = 'pausa';

DROP INDEX IF EXISTS flow_runs_vivas_por_conversacion_idx;

ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_wait_for_check;
ALTER TABLE flow_runs
  ADD CONSTRAINT flow_runs_wait_for_check CHECK (wait_for IN ('respuesta'));

COMMENT ON COLUMN flow_runs.wait_for IS NULL;
