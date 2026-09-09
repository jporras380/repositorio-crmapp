-- 0005 · Ingesta de webhooks y outbox. Cierra los requisitos 8.2 y 8.3.

-- ---------------------------------------------------------------------------
-- Eventos entrantes. Se escribe el crudo ANTES de procesar (ARCH §7).
--
-- Particionada por mes con retención corta: es la tabla que más crece y la que
-- menos valor tiene pasadas unas semanas. Su valor es poder reprocesar y poder
-- demostrar qué llegó exactamente cuando un proveedor dice que envió algo.
--
-- `tenant_id` es NULLABLE, y es deliberado: cuando llega un webhook todavía no
-- sabemos de quién es hasta resolver el channel_account. Una fila sin inquilino
-- no la ve nadie a través de RLS, que es exactamente lo correcto — la resuelve
-- el worker, que corre con rol de sistema.
-- ---------------------------------------------------------------------------
CREATE TABLE inbound_events (
  id                 uuid NOT NULL DEFAULT uuidv7(),
  tenant_id          uuid,
  channel            text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'tiktok')),
  channel_account_id uuid,
  signature_ok       boolean NOT NULL,
  raw                jsonb   NOT NULL,
  status             text    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'processed', 'failed', 'anomaly')),
  attempts           int     NOT NULL DEFAULT 0,
  error              jsonb,
  processed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbound_events
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON inbound_events TO crmapp_app;

CREATE INDEX inbound_events_pendientes_idx
  ON inbound_events (status, created_at) WHERE status IN ('pending', 'failed');
-- Las anomalías son reenvíos con cuerpo distinto: se alertan, no se
-- sobrescriben en silencio (ARCH §7).
CREATE INDEX inbound_events_anomalias_idx
  ON inbound_events (channel_account_id, created_at DESC) WHERE status = 'anomaly';

-- ---------------------------------------------------------------------------
-- Outbox (requisito 8.2).
--
-- Nada se publica a la cola dentro del flujo que hace commit: se escribe aquí
-- en la MISMA transacción que el cambio de negocio, y un relay lo publica
-- después. Sin esto se pierden eventos en el hueco entre commit y publish, y
-- ese hueco no se parchea luego: se evita desde fase 0.
--
-- NO lleva RLS ni se concede al rol de aplicación para lectura general: el
-- relay corre con rol de sistema y necesita ver todas las filas de todos los
-- inquilinos. Que un inquilino pueda leer el outbox de otro sería una fuga;
-- que el relay no pueda leerlo todo sería inútil. Se resuelve por permisos,
-- no por política.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  attempts       int   NOT NULL DEFAULT 0,
  last_error     text,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
-- La aplicación solo escribe, y solo lo suyo.
CREATE POLICY tenant_insert ON outbox FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_select ON outbox FOR SELECT
  USING (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT ON outbox TO crmapp_app;

-- El relay lo recorre con FOR UPDATE SKIP LOCKED sobre este índice parcial:
-- el volumen de filas pendientes es siempre pequeño aunque la tabla sea enorme.
CREATE INDEX outbox_pendientes_idx
  ON outbox (created_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Particiones iniciales. Desde el mes anterior hasta tres por delante.
-- ---------------------------------------------------------------------------
SELECT app.ensure_partitions_ahead(3);
