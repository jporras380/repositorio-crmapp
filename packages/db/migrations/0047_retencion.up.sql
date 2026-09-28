-- 0047 · Retención: dos tablas que crecían para siempre.
--
-- ## Lo que pasaba
--
-- **`message_keys`.** La migración 0004 escribió la política, creó el índice
-- para aplicarla (`message_keys_purga_idx ON (created_at)`) y `colas.ts`
-- declaró la tarea `purgar_message_keys`. Tres declaraciones apuntando a un
-- trabajo que **nadie hacía**. La política textual de 0004 era:
--
-- > Retención propia de 90 días: más allá, Meta ya no reenvía nada y la fila
-- > no protege de nada.
--
-- **`outbox`.** Ni política, ni índice, ni tarea. El relay marca
-- `published_at` y la fila se queda. Se descubrió persiguiendo el token de
-- invitación en claro (0046): esa credencial llevaba días ahí **porque nada
-- limpia esta tabla**.
--
-- ## Por qué funciones y no un GRANT DELETE al relay
--
-- Lo barato era `GRANT DELETE ON outbox TO crmapp_relay`. Eso le daría permiso
-- para borrar **cualquier fila**, incluidas las que todavía no se han
-- publicado — es decir, trabajo sin entregar: mensajes que un cliente cree
-- enviados.
--
-- Con `SECURITY DEFINER` el relay no gana el permiso, gana **poder llamar a
-- esto**, y lo que esto borra está escrito aquí y no en el código: publicadas,
-- viejas, y como mucho un lote. Es el mismo patrón que `ensure_partitions_ahead`
-- (0013), y por el mismo motivo.

-- ---------------------------------------------------------------------------
-- Outbox: solo lo PUBLICADO y viejo.
-- ---------------------------------------------------------------------------
--
-- Nunca lo pendiente. Dos casos distintos se protegen con la misma condición:
--
-- 1. Un evento aún sin publicar es trabajo por entregar.
-- 2. Uno que agotó `attempts` sin publicarse es una carta muerta, y es lo
--    ÚNICO que queda para saber qué falló. Borrarla es tapar el fallo.
--
-- El lote existe para que la primera pasada sobre una tabla que lleva meses
-- creciendo no bloquee la ingesta mientras borra. Se llama una vez al día: si
-- hay más, lo termina mañana.
CREATE OR REPLACE FUNCTION app.purgar_outbox(dias int DEFAULT 30, lote int DEFAULT 20000)
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  borradas bigint;
BEGIN
  IF dias < 7 THEN
    -- Menos de una semana no deja investigar un envío de la semana pasada,
    -- que es para lo único que sirve esta tabla una vez publicada.
    RAISE EXCEPTION 'La retención del outbox no baja de 7 días (pedidos: %)', dias;
  END IF;

  WITH viejas AS (
    SELECT id FROM outbox
     WHERE published_at IS NOT NULL
       AND published_at < now() - (dias || ' days')::interval
     ORDER BY id
     LIMIT lote
  )
  DELETE FROM outbox o USING viejas v WHERE o.id = v.id;

  GET DIAGNOSTICS borradas = ROW_COUNT;
  RETURN borradas;
END
$$;

-- ---------------------------------------------------------------------------
-- Claves de idempotencia: la política que 0004 dejó escrita y sin hacer.
-- ---------------------------------------------------------------------------
--
-- 90 días por lo que dice 0004: pasado eso, Meta ya no reenvía y la fila no
-- protege de nada. Bajar de ahí SÍ tiene consecuencia —un reenvío tardío se
-- convertiría en un mensaje duplicado para un huésped— y por eso el suelo está
-- en la función y no en quien la llama.
CREATE OR REPLACE FUNCTION app.purgar_message_keys(dias int DEFAULT 90, lote int DEFAULT 20000)
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  borradas bigint;
BEGIN
  IF dias < 90 THEN
    RAISE EXCEPTION
      'La retención de message_keys no baja de 90 días (ADR-006, pedidos: %)', dias;
  END IF;

  WITH viejas AS (
    SELECT channel_account_id, external_message_id
      FROM message_keys
     WHERE created_at < now() - (dias || ' days')::interval
     ORDER BY created_at
     LIMIT lote
  )
  DELETE FROM message_keys m USING viejas v
   WHERE m.channel_account_id = v.channel_account_id
     AND m.external_message_id = v.external_message_id;

  GET DIAGNOSTICS borradas = ROW_COUNT;
  RETURN borradas;
END
$$;

REVOKE ALL ON FUNCTION app.purgar_outbox(int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purgar_message_keys(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purgar_outbox(int, int) TO crmapp_relay;
GRANT EXECUTE ON FUNCTION app.purgar_message_keys(int, int) TO crmapp_relay;

-- El índice que faltaba. `message_keys` ya tenía el suyo desde 0004; el outbox
-- se purga por `published_at`, y sin esto cada pasada recorre la tabla entera
-- justo cuando más grande es.
--
-- Parcial: las filas sin publicar no se purgan nunca, así que no tienen por
-- qué ocupar sitio en él.
CREATE INDEX IF NOT EXISTS outbox_purga_idx
  ON outbox (published_at) WHERE published_at IS NOT NULL;
