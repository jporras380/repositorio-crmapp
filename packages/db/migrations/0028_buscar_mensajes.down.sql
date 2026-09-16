-- Reversa de 0028. No se pierde ningún mensaje: `search` se calcula desde
-- `body`, así que volver a crearla lo reconstruye todo.
DROP INDEX IF EXISTS messages_busqueda_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS search;
