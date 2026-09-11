-- 0020 · La bandeja: estado de atención, aplazar y vistas guardadas.
--
-- ## Los estados de atención NO se guardan: se deducen
--
-- El encargo pedía una lista de estados —Nuevo, En atención, Esperando
-- cliente, Seguimiento, Cerrado— y la forma obvia es una columna que el
-- agente mantiene a mano. Es también la forma de que mienta: nadie se acuerda
-- de marcar «esperando cliente» después de responder, así que a los dos días
-- el filtro no vale y la bandeja deja de usarse.
--
-- Casi todos esos estados ya están en los datos:
--
--   cerrada            `status = 'closed'`
--   seguimiento        aplazada hasta una fecha  ← lo único que hay que guardar
--   nueva              nadie ha respondido nunca (`human_reply_at IS NULL`)
--   por responder      el último mensaje es del cliente
--   esperando cliente  el último mensaje es nuestro
--
-- Así que esta migración añade **una sola columna** —hasta cuándo está
-- aplazada— y el resto se calcula al listar. El costo: un agente no puede
-- declarar «estoy en ello» sin responder. A cambio, ningún estado puede estar
-- desactualizado, que es el fallo que mata estas listas.
--
-- Que el bot conteste NO cuenta como atendida: `human_reply_at` lo pone la
-- puerta de envío solo cuando escribe una persona (0017). Una conversación
-- que solo ha hablado con el bot sigue siendo «nueva», que es exactamente lo
-- que un recepcionista necesita ver.

ALTER TABLE conversations ADD COLUMN snoozed_until timestamptz;

COMMENT ON COLUMN conversations.snoozed_until IS
  'Aplazada hasta aquí: sale de la bandeja activa y vuelve sola. Lo único del estado de atención que no se puede deducir.';

-- El barrido de la bandeja activa: lo aplazado que ya venció vuelve a la cola.
CREATE INDEX conversations_aplazadas_idx ON conversations (snoozed_until)
  WHERE snoozed_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Vistas guardadas
-- ---------------------------------------------------------------------------
-- Un filtro compuesto que alguien usa todos los días —«sin responder, de
-- WhatsApp, de hoy»— no se puede reconstruir a mano cada mañana. Se guarda
-- entero como JSON y no en columnas: son los mismos filtros que ya acepta la
-- API, y normalizarlos obligaría a una migración cada vez que se añada uno.
--
-- Por usuario y no por cuenta: la vista de un agente es su forma de trabajar,
-- no una configuración del hotel. Compartirlas es otra función, y cuando haga
-- falta se añade una columna, no se rehace esto.
CREATE TABLE inbox_views (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  filters    jsonb NOT NULL DEFAULT '{}'::jsonb,
  position   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inbox_views_nombre_uq ON inbox_views (user_id, lower(name));
CREATE INDEX inbox_views_orden_idx ON inbox_views (user_id, position);
SELECT app.enable_tenant_rls('inbox_views');
