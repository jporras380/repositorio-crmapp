-- Reversa de 0020. Se pierden las vistas guardadas de cada agente y los
-- aplazamientos en curso; las conversaciones y sus mensajes, no.
DROP TABLE IF EXISTS inbox_views;
DROP INDEX IF EXISTS conversations_aplazadas_idx;
ALTER TABLE conversations DROP COLUMN IF EXISTS snoozed_until;
