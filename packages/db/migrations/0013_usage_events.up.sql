-- 0013 · Medición de uso (ARCH §5.9), adelantada de fase 4 a fase 1.
--
-- Se emite un evento en el mismo punto donde ocurre el hecho (mensaje
-- recibido, mensaje entregado, conversación abierta, medio almacenado).
-- Añadirlo después obligaría a tocar todas las rutas y dejaría el periodo
-- anterior sin datos que reconstruir. Qué se COBRA de todo esto es P-21 y
-- sigue en la lista de parada: aquí solo se miden hechos.
--
-- La factura se calcula sobre `usage_rollups`, jamás contando `messages`.

-- ---------------------------------------------------------------------------
-- Eventos crudos, particionados por mes como `messages`.
-- ---------------------------------------------------------------------------
CREATE TABLE usage_events (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  metric      text NOT NULL,
  quantity    bigint NOT NULL CHECK (quantity >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  dedup_key   text NOT NULL,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_events
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- Solo inserción para la aplicación: un evento de uso no se edita ni se borra.
GRANT SELECT, INSERT ON usage_events TO crmapp_app;
CREATE INDEX usage_events_tenant_idx ON usage_events (tenant_id, metric, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Idempotencia. Como en `messages` (ADR-006): un índice único en una tabla
-- particionada debe incluir la columna de partición, y eso no sirve para
-- deduplicar. La clave vive aparte, sin particionar.
-- ---------------------------------------------------------------------------
CREATE TABLE usage_event_keys (
  dedup_key   text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL
);
SELECT app.enable_tenant_rls('usage_event_keys');

-- ---------------------------------------------------------------------------
-- Agregados por inquilino, métrica y mes. Se actualizan en la misma
-- transacción que el evento (una fila caliente por inquilino/métrica/mes;
-- bajo S-3 —menos de 200 msg/s— no es un problema; si lo fuera, se pasa a
-- un job de agregación y esta tabla no cambia de forma).
-- ---------------------------------------------------------------------------
CREATE TABLE usage_rollups (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric     text NOT NULL,
  -- Primer día del mes, en UTC.
  period     date NOT NULL,
  quantity   bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period)
);
SELECT app.enable_tenant_rls('usage_rollups');

-- ---------------------------------------------------------------------------
-- Precreación de particiones: añade `usage_events` y pasa a SECURITY DEFINER.
--
-- Crear una partición exige ser dueño de la tabla padre, y el worker corre
-- como `crmapp_relay`. Sin esto, el job diario de precreación no podría
-- existir y las particiones solo se crearían al migrar: a los tres meses,
-- caída de la ingesta. El search_path fijo es la precaución estándar de
-- toda función SECURITY DEFINER; `public` va primero porque `ensure_partition`
-- crea la partición con nombre sin esquema y PostgreSQL la pone en el primer
-- esquema del search_path (con pg_catalog delante fallaría: "System catalog
-- modifications are currently disallowed").
-- ---------------------------------------------------------------------------
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

REVOKE ALL ON FUNCTION app.ensure_partitions_ahead(int) FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO crmapp_relay;
GRANT EXECUTE ON FUNCTION app.ensure_partitions_ahead(int) TO crmapp_relay;

SELECT app.ensure_partitions_ahead(3);
