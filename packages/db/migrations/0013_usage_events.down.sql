-- Reversa de 0013. Pierde la medición acumulada: no es reconstruible.
REVOKE EXECUTE ON FUNCTION app.ensure_partitions_ahead(int) FROM crmapp_relay;

-- Se restaura la versión de 0001 (sin usage_events, sin SECURITY DEFINER).
CREATE OR REPLACE FUNCTION app.ensure_partitions_ahead(meses int DEFAULT 3)
  RETURNS SETOF text
  LANGUAGE plpgsql
  SECURITY INVOKER
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
  END LOOP;
END
$$;
ALTER FUNCTION app.ensure_partitions_ahead(int) RESET search_path;

DROP TABLE IF EXISTS usage_rollups;
DROP TABLE IF EXISTS usage_event_keys;
DROP TABLE IF EXISTS usage_events;
