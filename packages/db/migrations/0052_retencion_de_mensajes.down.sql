-- Reversa de 0052. No devuelve nada de lo ya borrado —eso no tiene vuelta—,
-- pero desde aquí no se borra nada más: todas las cuentas vuelven a guardar
-- sus mensajes para siempre, como antes.
DROP FUNCTION IF EXISTS app.purgar_mensajes_antiguos(int);
DROP INDEX IF EXISTS messages_medio_idx;
ALTER TABLE tenants DROP COLUMN IF EXISTS message_retention_months;
