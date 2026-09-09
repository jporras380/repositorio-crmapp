-- 0012 · Plantillas (ARCH §5.6): dos entidades, nunca un campo `tipo`.
--
-- `quick_replies` son internas del CRM: sin aprobación externa, disponibles
-- al instante y solo usables con ventana abierta (técnicamente son mensajes
-- libres). `wa_templates` son las HSM de WhatsApp: su estado lo fija Meta y
-- llega por sincronización o por webhook; nosotros solo lo reflejamos.
--
-- Las dos llevan VERSIONES y `messages` referencia la versión (columnas
-- `quick_reply_version_id` y `wa_template_version_id`, ya creadas en 0004):
-- una conversación de hace un año sigue mostrando el texto que se envió
-- entonces, no el que tiene la plantilla hoy.

-- ---------------------------------------------------------------------------
-- Respuestas rápidas
-- ---------------------------------------------------------------------------
CREATE TABLE quick_replies (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Atajo que escribe el agente en el compositor: "/gracias".
  shortcut           citext NOT NULL,
  title              text NOT NULL,
  -- Sin FK circular hacia quick_reply_versions: se mantiene desde la
  -- aplicación en la misma transacción que crea la versión.
  current_version_id uuid,
  -- Archivar, no borrar: los mensajes históricos apuntan a sus versiones.
  archived_at        timestamptz,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- El atajo es único entre las activas; una archivada libera el suyo.
CREATE UNIQUE INDEX quick_replies_shortcut_uq
  ON quick_replies (tenant_id, shortcut) WHERE archived_at IS NULL;
SELECT app.enable_tenant_rls('quick_replies');

CREATE TABLE quick_reply_versions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quick_reply_id uuid NOT NULL REFERENCES quick_replies(id) ON DELETE CASCADE,
  version        int  NOT NULL,
  body           text NOT NULL DEFAULT '',
  -- Adjunto opcional: un medio ya almacenado (0004 / ADR-009).
  media_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quick_reply_id, version)
);
SELECT app.enable_tenant_rls('quick_reply_versions');

-- ---------------------------------------------------------------------------
-- Plantillas de WhatsApp (HSM)
-- ---------------------------------------------------------------------------
CREATE TABLE wa_templates (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  name               text NOT NULL,
  language           text NOT NULL,
  -- Declarada por el usuario frente a fijada por Meta. La EFECTIVA es la que
  -- determina el coste; confundirlas es facturar mal (ARCH §5.6).
  category_declared  text,
  category_effective text,
  -- `borrador` es nuestro; el resto lo fija Meta.
  status             text NOT NULL DEFAULT 'borrador'
                       CHECK (status IN ('borrador', 'en_revision', 'aprobada', 'rechazada',
                                         'pausada', 'deshabilitada')),
  meta_template_id   text,
  quality_score      text,
  -- Se guarda y se muestra: es lo único que permite corregir un rechazo.
  rejection_reason   text,
  paused_until       timestamptz,
  last_synced_at     timestamptz,
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, name, language)
);
SELECT app.enable_tenant_rls('wa_templates');

CREATE TABLE wa_template_versions (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id      uuid NOT NULL REFERENCES wa_templates(id) ON DELETE CASCADE,
  version          int  NOT NULL,
  -- Estructura de Meta (cabecera, cuerpo, pie, botones). Vacía cuando la
  -- plantilla se creó en el panel de Meta y solo la sincronizamos.
  components       jsonb NOT NULL DEFAULT '[]'::jsonb,
  example_params   jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'borrador'
                     CHECK (status IN ('borrador', 'en_revision', 'aprobada', 'rechazada',
                                       'pausada', 'deshabilitada')),
  meta_template_id text,
  submitted_at     timestamptz,
  reviewed_at      timestamptz,
  rejection_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
SELECT app.enable_tenant_rls('wa_template_versions');
