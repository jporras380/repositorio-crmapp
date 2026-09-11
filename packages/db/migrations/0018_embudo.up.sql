-- 0018 · El embudo de ventas: tablero, etapas y leads.
--
-- ## La decisión que manda: un lead NO es una conversación
--
-- Es tentador tratar el hilo de WhatsApp como la oportunidad de venta: ya
-- existe, ya tiene contacto y ya tiene estado. Y se rompe con el primer
-- cliente que vuelve. En un hotel, volver es justo lo que se busca: la misma
-- familia reserva en Fiestas Patrias y otra vez en enero. Con un lead por
-- conversación, la segunda reserva o pisa la primera o abre un hilo duplicado
-- en la bandeja; en los dos casos el historial deja de valer y el pronóstico
-- cuenta mal.
--
-- Así que el lead es entidad propia, cuelga del CONTACTO, y guarda además la
-- conversación que lo originó. Un contacto tiene muchos leads a lo largo del
-- tiempo y como mucho uno abierto a la vez (lo impone un índice, más abajo).
-- El costo: hay que decidir, en cada entrante, si abre lead nuevo o entra en
-- el que ya está abierto. Esa regla vive en la ingesta y tiene test.
--
-- ## Por qué el orden dentro de una columna no se guarda
--
-- Kommo deja arrastrar tarjetas arriba y abajo dentro de la misma etapa. Eso
-- exige una columna de posición y un reordenado que es, en la práctica, una
-- fuente permanente de empates y de migraciones de reindexado. Aquí la
-- columna se ordena por fecha y punto: lo último que se movió, arriba. Se
-- pierde la prioridad manual; se gana no tener que mantenerla.

-- ---------------------------------------------------------------------------
-- Embudos y etapas
-- ---------------------------------------------------------------------------
CREATE TABLE pipelines (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  -- La moneda vive en el embudo y no en el inquilino: una cuenta puede querer
  -- un embudo de exportación en USD junto al de tienda en PEN, y mover el
  -- importe entre monedas no es cosa nuestra.
  currency   char(3) NOT NULL DEFAULT 'PEN',
  is_default boolean NOT NULL DEFAULT false,
  position   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pipelines_name_uq ON pipelines (tenant_id, lower(name));
-- Un solo embudo por defecto: es al que van los leads que abre la ingesta, y
-- si hubiera dos, el mismo mensaje entraría en uno u otro según el humor del
-- planificador.
CREATE UNIQUE INDEX pipelines_default_uq ON pipelines (tenant_id) WHERE is_default;
SELECT app.enable_tenant_rls('pipelines');

CREATE TABLE pipeline_stages (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text,
  -- `abierta` cuenta en el pronóstico; `ganada` y `perdida` cierran el lead.
  -- Es el tipo, no el nombre, quien decide: el cliente puede llamar «Recojo en
  -- tienda» a lo que quiera, pero el pronóstico no puede depender de cómo se
  -- llame una columna.
  kind        text NOT NULL DEFAULT 'abierta'
                CHECK (kind IN ('abierta', 'ganada', 'perdida')),
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pipeline_stages_orden_idx ON pipeline_stages (pipeline_id, position);
CREATE UNIQUE INDEX pipeline_stages_name_uq ON pipeline_stages (pipeline_id, lower(name));
SELECT app.enable_tenant_rls('pipeline_stages');

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id     uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  stage_id        uuid NOT NULL REFERENCES pipeline_stages(id) ON DELETE RESTRICT,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- La conversación que lo originó. Se guarda para poder saltar del tablero
  -- al hilo, que es el gesto que más se repite. `SET NULL` y no `CASCADE`:
  -- purgar conversaciones antiguas no puede borrar la venta.
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  title           text NOT NULL,
  -- En céntimos y entero. Un `numeric` sería más correcto contablemente, pero
  -- esto no es contabilidad: es un pronóstico que se suma y se pinta.
  amount_cents    bigint NOT NULL DEFAULT 0,
  -- Redundante con `pipeline_stages.kind` y a propósito: el índice de «lead
  -- abierto de este contacto» lo consulta la ingesta en cada entrante, y un
  -- join con la etapa en ese camino se paga en cada mensaje que llega.
  status          text NOT NULL DEFAULT 'abierto'
                    CHECK (status IN ('abierto', 'ganado', 'perdido')),
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
-- El tablero: una etapa, ordenada por lo último movido.
CREATE INDEX leads_tablero_idx ON leads (tenant_id, stage_id, updated_at DESC);
CREATE INDEX leads_contacto_idx ON leads (contact_id, created_at DESC);
-- Un lead abierto por contacto y embudo. Es lo que impide que tres mensajes
-- seguidos de la misma persona abran tres tarjetas idénticas, y es también lo
-- que hace que la regla de la ingesta sea decidible sin bloquear la tabla.
CREATE UNIQUE INDEX leads_abierto_uq ON leads (contact_id, pipeline_id)
  WHERE status = 'abierto';
SELECT app.enable_tenant_rls('leads');

CREATE TABLE lead_tags (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id   uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id    uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);
CREATE INDEX lead_tags_tag_idx ON lead_tags (tag_id);
SELECT app.enable_tenant_rls('lead_tags');

-- El historial del lead. Sin esto, «¿por qué esta venta está en cotización
-- desde hace tres semanas?» no tiene respuesta, y el tablero se convierte en
-- una foto sin memoria.
CREATE TABLE lead_events (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type          text NOT NULL,
  from_stage_id uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id   uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  meta          jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_events_lead_idx ON lead_events (lead_id, at);
SELECT app.enable_tenant_rls('lead_events');

-- ---------------------------------------------------------------------------
-- Un embudo por cuenta, ya montado
-- ---------------------------------------------------------------------------
-- Las etapas que se siembran son el recorrido de una reserva de hotel —de la
-- consulta suelta a la reserva confirmada— y se pueden renombrar, recolorear,
-- reordenar y borrar desde la interfaz. Se siembran porque un tablero vacío no
-- es una pantalla, es un formulario: la primera pregunta que nadie sabe
-- contestar es cuántas columnas debería haber.
--
-- Que el embudo se llame «Reservas» y no «Ventas» no es decoración: es el
-- vocabulario con el que habla quien lo va a usar todos los días.
-- Vive como FUNCIÓN y no como un INSERT suelto porque hacen falta dos
-- llamantes: esta migración, para los inquilinos que ya existen, y el alta de
-- cuenta, para los que vengan. Con el SQL copiado en TypeScript, el día que
-- alguien añada una etapa por defecto solo la tendría la mitad de los
-- clientes, y nadie se enteraría hasta ver un tablero raro.
--
-- Sin SECURITY DEFINER a propósito: la llama el alta dentro de su propia
-- transacción, con `app.tenant_id` ya puesto, así que RLS sigue aplicando y
-- una cuenta no puede sembrarle un embudo a otra.
CREATE OR REPLACE FUNCTION app.sembrar_embudo(p_tenant uuid) RETURNS uuid AS $$
DECLARE
  v_pipeline uuid;
BEGIN
  INSERT INTO pipelines (tenant_id, name, is_default)
  VALUES (p_tenant, 'Reservas', true)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_pipeline;

  -- Ya tenía embudo por defecto: no se toca nada. Sembrar dos veces
  -- duplicaría columnas en el tablero de alguien que ya las renombró.
  IF v_pipeline IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, color, kind, position)
  SELECT p_tenant, v_pipeline, e.name, e.color, e.kind, e.position
    FROM (VALUES
      ('Consulta',           '#0A84FF', 'abierta', 0),
      ('Interesado',         '#5E5CE6', 'abierta', 1),
      ('Cotización enviada', '#FF9F0A', 'abierta', 2),
      ('Reserva pendiente',  '#FF375F', 'abierta', 3),
      ('Confirmada',         '#30D158', 'ganada',  4),
      ('Perdida',            '#8E8E93', 'perdida', 5)
    ) AS e(name, color, kind, position);

  RETURN v_pipeline;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION app.sembrar_embudo(uuid) TO crmapp_app;

SELECT app.sembrar_embudo(id) FROM tenants;

-- Las conversaciones abiertas de hoy YA son leads: no se están inventando
-- datos, se está traduciendo el estado que existe al modelo nuevo. Cada
-- contacto con conversación abierta entra una sola vez, con su conversación
-- más reciente y en la primera etapa.
-- El título sale del PRIMER mensaje del cliente, igual que para los leads que
-- abra la ingesta a partir de ahora (`apps/worker/src/leads.ts`). Poner el
-- nombre del contacto daría una tarjeta que repite el mismo texto dos veces y
-- no dice qué pide esa persona, que es lo único que hace útil el tablero.
INSERT INTO leads (tenant_id, pipeline_id, stage_id, contact_id, conversation_id, title, created_at)
SELECT DISTINCT ON (c.contact_id)
       c.tenant_id,
       p.id,
       s.id,
       c.contact_id,
       c.id,
       COALESCE(
         NULLIF(
           CASE WHEN length(primero.body) > 60
                THEN left(primero.body, 59) || '…'
                ELSE primero.body END, ''),
         NULLIF(ct.display_name, ''),
         'Consulta'),
       c.created_at
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  JOIN pipelines p ON p.tenant_id = c.tenant_id AND p.is_default
  JOIN pipeline_stages s ON s.pipeline_id = p.id AND s.position = 0
  LEFT JOIN LATERAL (
    SELECT m.body
      FROM messages m
     WHERE m.conversation_id = c.id
       AND m.direction = 'inbound'
       AND m.body IS NOT NULL AND m.body <> ''
     ORDER BY m.created_at
     LIMIT 1
  ) primero ON true
 WHERE c.status <> 'closed'
 ORDER BY c.contact_id, c.last_inbound_at DESC NULLS LAST, c.created_at DESC;
