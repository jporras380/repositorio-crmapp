-- 0052 · Cuánto tiempo guarda el hotel sus mensajes.
--
-- ## Quién decide
--
-- Cuánto historial de conversaciones se guarda es una decisión de cada hotel,
-- no de la plataforma: lo dijo 0047 al dejar `messages` fuera de su purga.
-- Por eso es un ajuste de la cuenta y **viene apagado**: `NULL` es «para
-- siempre», que es lo que pasaba hasta hoy. Ninguna cuenta pierde nada por
-- esta migración.
--
-- El mínimo es un año. Menos dejaría sin historial a quien vuelve cada
-- verano, que en un hotel de playa es el cliente que más importa.
--
-- ## Qué se borra
--
-- Los mensajes más viejos que el plazo y **sus archivos** (fotos, audios,
-- documentos): borrar el texto y dejar las fotos de los huéspedes en el
-- almacén sería lo contrario de lo que el hotel pidió.
--
-- Un archivo solo se borra si **nada más lo usa**. Las referencias, todas:
--
-- | Tabla                   | Columna            | Qué es                         |
-- |-------------------------|--------------------|--------------------------------|
-- | messages                | media_asset_id     | otro mensaje (deduplicado)     |
-- | quick_reply_versions    | media_asset_id     | adjunto de respuesta rápida    |
-- | subscription_payments   | receipt_media_id   | la boleta que subió el operador|
-- | support_messages        | media_asset_id     | captura del chat de soporte    |
-- | payment_claims          | media_asset_id     | voucher de un pago declarado   |
-- | users                   | avatar_media_id    | foto de perfil (sin FK, 0034)  |
--
-- Las cuatro con FK son `ON DELETE SET NULL`: si faltara una aquí, borrar el
-- archivo NO daría error, simplemente dejaría la boleta del cliente en blanco.
-- Por eso hay un test que busca toda columna uuid con «media» en el nombre y
-- exige que esta función la mencione: una tabla nueva con archivos no puede
-- entrar sin que alguien decida qué hace la retención con ella.
--
-- ## Por qué una función y no un DELETE en el worker
--
-- El mismo patrón que 0047: el worker no gana permiso para borrar mensajes,
-- gana poder llamar a esto, y lo que esto borra está escrito aquí. Devuelve
-- las claves del almacén para que el worker borre los objetos DESPUÉS de que
-- la transacción confirme: si fuera al revés y la transacción fallara, habría
-- filas apuntando a archivos que ya no existen.

ALTER TABLE tenants
  ADD COLUMN message_retention_months smallint
    CHECK (message_retention_months IN (12, 24, 36, 60));

COMMENT ON COLUMN tenants.message_retention_months IS
  'Meses que se guardan los mensajes y sus archivos. NULL = para siempre (por defecto).';

-- Sin esto, cada «¿lo usa otro mensaje?» recorre todos los mensajes de la
-- cuenta. Parcial: la gran mayoría de mensajes no lleva archivo.
CREATE INDEX messages_medio_idx ON messages (media_asset_id) WHERE media_asset_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.purgar_mensajes_antiguos(lote int DEFAULT 5000)
  RETURNS TABLE (inquilino uuid, mensajes bigint, claves text[])
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  t record;
  v_mensajes bigint;
  v_medios uuid[];
  v_claves text[];
BEGIN
  FOR t IN
    SELECT id, message_retention_months AS meses
      FROM tenants
     -- El CHECK ya impide menos de 12; se repite aquí porque esta función
     -- es la que borra, y no debe depender de que nadie relaje el CHECK.
     WHERE message_retention_months IS NOT NULL AND message_retention_months >= 12
  LOOP
    WITH viejos AS (
      SELECT m.created_at, m.id
        FROM messages m
       WHERE m.tenant_id = t.id
         AND m.created_at < now() - make_interval(months => t.meses)
       LIMIT lote
    ), borrados AS (
      DELETE FROM messages m
       USING viejos v
       WHERE m.created_at = v.created_at AND m.id = v.id
      RETURNING m.media_asset_id
    )
    SELECT count(*),
           array_agg(DISTINCT media_asset_id) FILTER (WHERE media_asset_id IS NOT NULL)
      INTO v_mensajes, v_medios
      FROM borrados;

    CONTINUE WHEN v_mensajes = 0;

    WITH huerfanos AS (
      DELETE FROM media_assets a
       WHERE a.tenant_id = t.id
         AND a.id = ANY (coalesce(v_medios, '{}'::uuid[]))
         AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.media_asset_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM quick_reply_versions x WHERE x.media_asset_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM subscription_payments x WHERE x.receipt_media_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM support_messages x WHERE x.media_asset_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM payment_claims x WHERE x.media_asset_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM users x WHERE x.avatar_media_id = a.id)
      RETURNING a.storage_key, a.thumb_key
    )
    SELECT array_agg(k) FILTER (WHERE k IS NOT NULL)
      INTO v_claves
      FROM huerfanos, LATERAL unnest(ARRAY[huerfanos.storage_key, huerfanos.thumb_key]) AS k;

    -- Sin autor: lo hizo el sistema, por el ajuste que puso el hotel.
    INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, meta)
    VALUES (t.id, 'retencion.mensajes_borrados', 'tenant', t.id,
            jsonb_build_object('mensajes', v_mensajes,
                               'archivos', coalesce(cardinality(v_claves), 0),
                               'meses', t.meses));

    inquilino := t.id;
    mensajes := v_mensajes;
    claves := coalesce(v_claves, '{}'::text[]);
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION app.purgar_mensajes_antiguos(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purgar_mensajes_antiguos(int) TO crmapp_relay;
