-- 0004 · Conversaciones, mensajes particionados y el registro de idempotencia.
-- Ver ADR-006 (particionado e idempotencia).

-- ---------------------------------------------------------------------------
-- Medios. NO particionada, y referenciada DESDE `messages`.
--
-- La dirección de la referencia no es casual: si `media_assets` apuntara a
-- `messages`, necesitaría la clave compuesta (created_at, id) de la tabla
-- particionada en cada fila. Apuntando al revés, la clave foránea es simple.
-- Un mensaje lleva como mucho un medio, que es como funcionan las APIs de
-- WhatsApp e Instagram: un adjunto por mensaje.
-- ---------------------------------------------------------------------------
CREATE TABLE media_assets (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document', 'sticker')),
  storage_key  text,
  mime         text,
  bytes        bigint,
  width        int,
  height       int,
  duration_ms  int,
  -- Deduplicación: el mismo archivo enviado a 500 contactos se almacena una vez.
  sha256       text,
  -- La URL firmada de WhatsApp caduca pronto. Guardar la fecha hace visible
  -- que es perecedera, en vez de descubrirlo con un 404 en producción.
  remote_url        text,
  remote_expires_at timestamptz,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'stored', 'failed')),
  thumb_key    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('media_assets');
CREATE INDEX media_assets_sha_idx ON media_assets (tenant_id, sha256) WHERE sha256 IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Conversaciones.
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- El hilo pertenece al canal, así que cuelga de la identidad...
  contact_identity_id uuid NOT NULL REFERENCES contact_identities(id) ON DELETE CASCADE,
  -- ...y `contact_id` va desnormalizado para la vista unificada. Es la
  -- consulta más caliente del producto y no puede pagar un join extra.
  -- Contrapartida: hay que mantenerlo en cada fusión de contactos, y ese
  -- invariante tiene test (ADR-007).
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_account_id  uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  kind                text NOT NULL DEFAULT 'dm'
                        CHECK (kind IN ('dm', 'comment_thread')),
  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'pending', 'snoozed', 'closed')),
  assignee_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  team_id             uuid REFERENCES teams(id) ON DELETE SET NULL,
  -- Identificador del hilo en el proveedor (publicación + comentario en IG).
  external_thread_id  text,
  last_inbound_at     timestamptz,
  last_outbound_at    timestamptz,
  -- Un INSTANTE, no unas horas. La duración de la ventana es del canal y
  -- puede cambiar; el instante calculado no. Lo escribe el servidor al
  -- ingerir un entrante y es contra esta columna contra la que la API
  -- rechaza el envío libre (ARCH §9).
  session_expires_at  timestamptz,
  first_response_at   timestamptz,
  closed_at           timestamptz,
  unread_count        int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('conversations');

-- La consulta de la bandeja.
CREATE INDEX conversations_bandeja_idx
  ON conversations (tenant_id, status, last_inbound_at DESC);
-- "Mis conversaciones".
CREATE INDEX conversations_asignadas_idx
  ON conversations (tenant_id, assignee_user_id, status);
-- El aviso de ventana por expirar. Parcial: las cerradas no interesan y son
-- la mayoría del histórico.
CREATE INDEX conversations_ventana_idx
  ON conversations (tenant_id, session_expires_at)
  WHERE status <> 'closed';
CREATE INDEX conversations_contacto_idx ON conversations (tenant_id, contact_id);

-- ---------------------------------------------------------------------------
-- Mensajes. Particionada por rango de created_at, mensual.
--
-- La PK incluye la columna de partición porque PostgreSQL lo exige. Esa
-- exigencia es la que hace imposible el índice único de idempotencia sobre
-- (channel_account_id, external_message_id) y obliga a `message_keys`.
-- Ver ADR-006.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  conversation_id     uuid NOT NULL,
  channel_account_id  uuid NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  type                text NOT NULL
                        CHECK (type IN ('text', 'image', 'video', 'audio', 'document',
                                        'location', 'sticker', 'template', 'system')),
  body                text,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  media_asset_id      uuid,
  external_message_id text,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed')),
  error               jsonb,
  -- Quién lo originó. `ai_generated` es redundante con sent_by='ai' a
  -- propósito: el requisito de marcar todo mensaje de IA es de cumplimiento,
  -- y una columna booleana explícita es más difícil de perder en un refactor
  -- que un valor dentro de un CHECK.
  sent_by             text NOT NULL DEFAULT 'human'
                        CHECK (sent_by IN ('human', 'bot', 'ai', 'system')),
  sent_by_user_id     uuid,
  ai_generated        boolean NOT NULL DEFAULT false,
  -- Referencian la VERSIÓN de la plantilla, nunca la plantilla: es lo que
  -- permite que una conversación histórica siga mostrando el texto realmente
  -- enviado. Las tablas llegan en el PR de plantillas; las columnas se
  -- declaran ya para no tener que alterar una tabla particionada después.
  wa_template_version_id  uuid,
  quick_reply_version_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO crmapp_app;

CREATE INDEX messages_conversacion_idx ON messages (conversation_id, created_at DESC);
CREATE INDEX messages_tenant_idx ON messages (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Registro de idempotencia. NO particionada — esa es toda su razón de ser.
--
-- Con `messages` particionada, un UNIQUE que incluya created_at solo garantiza
-- unicidad DENTRO de cada partición mensual: un reenvío de Meta a caballo de
-- fin de mes se duplicaría. Ese fallo es estacional, pasa todos los tests y
-- solo aparece en producción. Ver ADR-006.
--
-- No lleva clave foránea a `messages` para no arrastrar la clave compuesta.
-- La integridad la sostiene la transacción de ingesta, que escribe ambas.
--
-- Retención propia de 90 días: más allá, Meta ya no reenvía nada y la fila no
-- protege de nada.
-- ---------------------------------------------------------------------------
CREATE TABLE message_keys (
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_account_id  uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  external_message_id text NOT NULL,
  message_id          uuid NOT NULL,
  message_created_at  timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_account_id, external_message_id)
);
SELECT app.enable_tenant_rls('message_keys');
CREATE INDEX message_keys_purga_idx ON message_keys (created_at);

CREATE TABLE internal_notes (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('internal_notes');
CREATE INDEX internal_notes_conversacion_idx ON internal_notes (conversation_id, created_at DESC);

CREATE TABLE conversation_tags (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id          uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, tag_id)
);
SELECT app.enable_tenant_rls('conversation_tags');
