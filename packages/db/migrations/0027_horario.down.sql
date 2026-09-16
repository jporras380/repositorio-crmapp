-- Reversa de 0027. El horario en sí (`timezone`, `schedule`) sigue en
-- `business_hours` desde 0002; se pierden el aviso y su texto.
ALTER TABLE conversations DROP COLUMN IF EXISTS out_of_hours_reply_at;
DROP INDEX IF EXISTS business_hours_por_equipo_uq;
ALTER TABLE business_hours
  DROP COLUMN IF EXISTS auto_reply_text,
  DROP COLUMN IF EXISTS auto_reply_enabled;
