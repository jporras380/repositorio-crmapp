-- Reversa de 0047.
--
-- Las filas ya purgadas no vuelven, y no deberían: eran eventos publicados de
-- hace más de un mes y claves de idempotencia de hace más de tres. Lo que se
-- deshace es la capacidad de purgar, no la purga.
--
-- Tras revertir esto, las dos tablas vuelven a crecer sin límite. Está dicho
-- aquí para que quien revierta sepa qué se lleva por delante.
DROP INDEX IF EXISTS outbox_purga_idx;
DROP FUNCTION IF EXISTS app.purgar_outbox(int, int);
DROP FUNCTION IF EXISTS app.purgar_message_keys(int, int);
