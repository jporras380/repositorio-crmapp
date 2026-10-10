-- Reversa de 0055.
--
-- Se pierde la agenda de nombres. Los mensajes importados NO se borran, ni
-- sus particiones: son conversaciones de verdad del hotel, y una partición
-- vacía no molesta. Lo que vuelve atrás es que ya no se crean particiones
-- nuevas tan lejos, así que un historial que llegara después no cabría.
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

DROP TABLE IF EXISTS channel_contact_names;
