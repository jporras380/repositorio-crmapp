-- Reversa de 0045.
--
-- Las vistas que estaban compartidas **se quedan, y pasan a ser privadas de
-- quien las creó**: no se borran. Borrarlas sería perder el trabajo de
-- configurar cinco filtros por revertir una migración, y quien las creó puede
-- volver a compartirlas si esto se reaplica.
--
-- Lo que sí se pierde es que el resto del equipo las vea, porque sin la
-- columna no hay forma de saber cuáles lo estaban.
DROP INDEX IF EXISTS inbox_views_compartida_nombre_uq;
DROP INDEX IF EXISTS inbox_views_compartidas_idx;
ALTER TABLE inbox_views DROP COLUMN IF EXISTS is_public;
