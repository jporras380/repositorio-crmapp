-- 0015 · Salesbots (ARCH §5.7, ADR-002): el estado del flujo vive aquí.
--
-- La decisión que manda sobre todas las demás: **`flow_runs` apunta a la
-- VERSIÓN del flujo, no al flujo**. Publicar una versión nueva mientras hay
-- cuatrocientas ejecuciones a medias no puede hacer que esas cuatrocientas
-- salten a un nodo que en su grafo no existe: terminan con la versión con la
-- que empezaron. Es la respuesta al versionado en vuelo, que es la parte que
-- Temporal regala y aquí hay que decidir a mano.
--
-- Redis solo es el despertador. Un flujo que espera tres días es una fila con
-- `wait_until` más un delayed job; si el job se pierde —Redis reiniciado, cola
-- purgada—, el barrido periódico lo recupera desde esta tabla. Por eso el
-- índice parcial sobre `wait_until` no es un lujo: es la red de seguridad.

-- ---------------------------------------------------------------------------
-- Flujo y sus versiones
-- ---------------------------------------------------------------------------
CREATE TABLE flows (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               text NOT NULL,
  -- borrador: nunca se ha publicado. activo: dispara. pausado: no dispara,
  -- pero las ejecuciones en vuelo siguen — pausar no es cancelar.
  status             text NOT NULL DEFAULT 'borrador'
                     CHECK (status IN ('borrador', 'activo', 'pausado')),
  -- Sin FK circular hacia flow_versions: se mantiene desde la aplicación en
  -- la misma transacción que publica la versión (igual que quick_replies).
  current_version_id uuid,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX flows_name_uq ON flows (tenant_id, lower(name));
SELECT app.enable_tenant_rls('flows');

CREATE TABLE flow_versions (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flow_id    uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  version    int  NOT NULL,
  -- El grafo entero, tal como lo valida packages/core. Es jsonb y no tablas
  -- de nodos y aristas a propósito: se lee y se escribe siempre completo, y
  -- normalizarlo solo añadiría joins para consultas que nadie hace.
  graph      jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);
SELECT app.enable_tenant_rls('flow_versions');

-- ---------------------------------------------------------------------------
-- Disparadores
-- ---------------------------------------------------------------------------
CREATE TABLE flow_triggers (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flow_id    uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- conversacion_abierta: primer mensaje de una conversación nueva.
  -- palabra_clave: el contacto escribe alguna de las palabras de `config`.
  type       text NOT NULL CHECK (type IN ('conversacion_abierta', 'palabra_clave')),
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX flow_triggers_flow_idx ON flow_triggers (flow_id);
SELECT app.enable_tenant_rls('flow_triggers');

-- ---------------------------------------------------------------------------
-- Ejecuciones
-- ---------------------------------------------------------------------------
CREATE TABLE flow_runs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Redundante con flow_versions.flow_id, y a propósito: el índice único
  -- parcial de abajo necesita el flujo en esta fila para impedir dos
  -- ejecuciones vivas del mismo flujo en la misma conversación.
  flow_id         uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_version_id uuid NOT NULL REFERENCES flow_versions(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'waiting', 'done', 'failed', 'cancelled')),
  -- Nodo en el que está parada. El avance es un compare-and-swap contra esta
  -- columna (ADR-002): si el UPDATE afecta a cero filas, otro worker ya
  -- avanzó y este job se descarta en vez de enviar dos veces.
  current_node_id text,
  -- Cuándo hay que despertarla, y qué espera. `respuesta` significa que un
  -- entrante del contacto la reanuda antes de que venza el plazo.
  wait_until      timestamptz,
  wait_for        text CHECK (wait_for IN ('respuesta')),
  -- Variables del flujo: lo que respondió el contacto, contadores, etc.
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
-- La red de seguridad de los temporizadores: el barrido lee por aquí.
CREATE INDEX flow_runs_pendientes_idx ON flow_runs (wait_until)
  WHERE status = 'waiting';
-- Un flujo, una ejecución viva por conversación. Sin esto, tres entrantes
-- seguidos arrancan tres bots que se pisan y el contacto recibe el saludo
-- tres veces.
CREATE UNIQUE INDEX flow_runs_vivas_uq ON flow_runs (conversation_id, flow_id)
  WHERE status IN ('running', 'waiting');
CREATE INDEX flow_runs_conversacion_idx ON flow_runs (conversation_id);
SELECT app.enable_tenant_rls('flow_runs');

-- El log paso a paso. Es el requisito de auditoría —«¿por qué el bot dijo
-- eso?»— y es también la herramienta de soporte: cuando un flujo haga algo
-- raro delante de un cliente, la respuesta está en un SELECT.
CREATE TABLE flow_run_steps (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flow_run_id uuid NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  node_id     text NOT NULL,
  kind        text NOT NULL,
  input       jsonb,
  output      jsonb,
  error       text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX flow_run_steps_run_idx ON flow_run_steps (flow_run_id, at);
SELECT app.enable_tenant_rls('flow_run_steps');

-- ---------------------------------------------------------------------------
-- El barrido de rescate necesita mirar TODOS los inquilinos
-- ---------------------------------------------------------------------------
-- Y RLS —con razón— no le deja. Se resuelve como en 0006 y por las mismas
-- razones: una política acotada a ESTA tabla para el rol del relay, nunca
-- BYPASSRLS, que sería un escape para toda la base que luego nadie recuerda.
--
-- Además, permiso por COLUMNA: el barrido solo necesita saber qué ejecución
-- despertar y de quién es. El contexto del flujo —lo que dijo el contacto—
-- no lo puede leer ni queriendo.
GRANT SELECT (id, tenant_id, status, wait_until) ON flow_runs TO crmapp_relay;

CREATE POLICY relay_lectura ON flow_runs
  FOR SELECT
  TO crmapp_relay
  USING (true);

COMMENT ON POLICY relay_lectura ON flow_runs IS
  'El barrido de esperas ve todos los inquilinos, y solo cuatro columnas. Escape acotado, deliberadamente no BYPASSRLS.';
