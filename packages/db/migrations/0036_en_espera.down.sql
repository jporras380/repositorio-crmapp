-- Reversa de 0036. Las que estaban en espera vuelven a ser conversaciones
-- normales: el bot puede volver a hablarles. Se pierde una decisión del
-- equipo, no datos del cliente.
DROP INDEX IF EXISTS conversations_en_espera_idx;
ALTER TABLE conversations DROP COLUMN IF EXISTS on_hold_at;
