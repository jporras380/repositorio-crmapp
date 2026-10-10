-- 0055 · Historial y agenda de la app WhatsApp Business (coexistencia).
--
-- Al conectar por QR (ADR-015), el dueño pulsa «Compartir chats» en su
-- celular y Meta manda los contactos de la app y hasta 180 días de
-- conversaciones. Hacen falta dos cosas para guardarlos bien.
--
-- ## 1. Particiones hacia atrás
--
-- `messages` va particionada por mes y solo había particiones desde el mes
-- pasado: un mensaje de hace cinco meses no tenía dónde caer. Hasta hoy eso
-- se esquivaba guardando todo con la fecha de RECEPCIÓN, que para un mensaje
-- en vivo es lo mismo. Para un historial no: 180 días de chats con fecha de
-- hoy salen todos como «de hoy», en el orden en que llegó cada tanda.
--
-- Así que las de `messages` se crean siete meses hacia atrás —180 días más
-- el mes en curso—, y el mensaje importado lleva su fecha de verdad. Las
-- demás tablas siguen igual: no reciben nada antiguo.
--
-- ## 2. La agenda del celular
--
-- El historial dice con qué número se habló, no cómo se llama. Los nombres
-- vienen aparte y ANTES, en la sincronización de contactos. Si se creara un
-- cliente por cada contacto de la agenda, «Clientes» se llenaría de gente con
-- la que el hotel nunca ha hablado por aquí —proveedores, familia—. Y si se
-- tiraran, seis meses de chats saldrían como números sin nombre.
--
-- Por eso se guardan aparte, y solo se usan para ponerle nombre a quien SÍ
-- tiene conversación. Es la agenda que el hotel ya tiene en su teléfono: no
-- sale de su cuenta (RLS), y se borra con el canal.

CREATE TABLE channel_contact_names (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  -- El mismo identificador que `contact_identities.external_user_id`.
  external_user_id   text NOT NULL,
  display_name       text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_account_id, external_user_id)
);
SELECT app.enable_tenant_rls('channel_contact_names');

COMMENT ON TABLE channel_contact_names IS
  'Nombres con que el negocio tiene guardados sus contactos en la app del canal (agenda de WhatsApp Business). Solo para nombrar a quien tiene conversación; no crea clientes.';

CREATE OR REPLACE FUNCTION app.ensure_partitions_ahead(meses int DEFAULT 3)
  RETURNS SETOF text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  base date := date_trunc('month', now())::date;
  i    int;
BEGIN
  -- Solo `messages` mira tan atrás: es donde cae un historial importado.
  FOR i IN -7 .. -2 LOOP
    RETURN NEXT app.ensure_partition(
      'public.messages', (base + (i || ' month')::interval)::date);
  END LOOP;
  FOR i IN -1 .. meses LOOP
    RETURN NEXT app.ensure_partition(
      'public.messages', (base + (i || ' month')::interval)::date);
    RETURN NEXT app.ensure_partition(
      'public.audit_log', (base + (i || ' month')::interval)::date,
      true, 'SELECT, INSERT');
    RETURN NEXT app.ensure_partition(
      'public.inbound_events', (base + (i || ' month')::interval)::date);
    RETURN NEXT app.ensure_partition(
      'public.usage_events', (base + (i || ' month')::interval)::date,
      true, 'SELECT, INSERT');
  END LOOP;
END
$$;

SELECT app.ensure_partitions_ahead(3);
