-- Reversa de 0030. Los bots vuelven a hablar a cualquier hora, que es lo que
-- hacían antes: no se pierde nada más que la preferencia.
ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_active_hours_check;
ALTER TABLE flows DROP COLUMN IF EXISTS active_hours;
