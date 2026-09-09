-- 0003 · Cuentas de canal, secretos e identidad de contactos.
-- Ver ADR-004 (modelo de WhatsApp) y ADR-007 (identidad de contactos).

CREATE TABLE channel_accounts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel      text   NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'tiktok')),
  -- phone_number_id en WhatsApp, ig_user_id en Instagram.
  external_id  text   NOT NULL,
  display_name text   NOT NULL,
  status       text   NOT NULL DEFAULT 'disconnected'
                 CHECK (status IN ('disconnected', 'connected', 'degraded', 'blocked')),
  -- jsonb a propósito: la forma la dicta Meta y cambia sin avisarnos.
  -- Modelarlo en columnas sería inventar un esquema sobre datos ajenos.
  quality      jsonb  NOT NULL DEFAULT '{}'::jsonb,
  limits       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  -- Cuándo se sincronizó por última vez con el proveedor. Si se queda atrás,
  -- el canal puede estar caído en silencio (ARCH §7).
  last_synced_at timestamptz,
  last_event_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('channel_accounts');

-- Unicidad GLOBAL, no por inquilino: un mismo número no puede estar conectado
-- a dos cuentas. Kommo impone la misma restricción y por buenos motivos —
-- dos inquilinos recibiendo el mismo webhook es un estado sin dueño claro.
CREATE UNIQUE INDEX channel_accounts_external_idx
  ON channel_accounts (channel, external_id);

-- ---------------------------------------------------------------------------
-- Secretos de canal. Envelope encryption (ARCH §11).
--
-- `key_version` por fila permite rotar la clave maestra sin reescribir toda la
-- tabla de golpe: las filas viejas se descifran con la versión con la que se
-- cifraron y se van migrando.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_secrets (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_account_id uuid  NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  kind               text  NOT NULL
                       CHECK (kind IN ('access_token', 'app_secret', 'webhook_secret', 'refresh_token')),
  ciphertext         bytea NOT NULL,
  dek_wrapped        bytea NOT NULL,
  key_version        int   NOT NULL,
  expires_at         timestamptz,
  rotated_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, kind)
);
SELECT app.enable_tenant_rls('channel_secrets');

-- ---------------------------------------------------------------------------
-- Contactos: la persona.
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name text,
  locale       text,
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('contacts');

-- ---------------------------------------------------------------------------
-- Identidades: el hecho del proveedor.
--
-- Separadas de `contacts` desde el esquema inicial (ADR-007). El identificador
-- de Instagram va acotado a nuestra app: no es el @handle público y no sirve
-- para cruzarlo con nada externo. Confirmación empírica de que la identidad
-- del canal no puede ser la clave de la persona.
-- ---------------------------------------------------------------------------
CREATE TABLE contact_identities (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel            text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'tiktok')),
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  external_user_id   text NOT NULL,
  handle             text,
  -- Teléfono en E.164 cuando el canal lo entrega. Es la única señal fuerte
  -- para proponer una fusión (P-08); el nombre no lo es y nunca lo será.
  phone_e164         text,
  profile            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('contact_identities');

CREATE UNIQUE INDEX contact_identities_external_idx
  ON contact_identities (channel_account_id, external_user_id);
CREATE INDEX contact_identities_contact_idx ON contact_identities (contact_id);
CREATE INDEX contact_identities_phone_idx
  ON contact_identities (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL;

-- Registro de fusiones. Existe para que fusionar sea reversible: sin él,
-- deshacer una fusión equivocada es imposible y el error es irreparable.
CREATE TABLE contact_merges (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_contact_id uuid NOT NULL,
  target_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  merged_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  reason            text NOT NULL
                      CHECK (reason IN ('manual', 'verified_phone')),
  reverted_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('contact_merges');

CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  color      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT app.enable_tenant_rls('tags');

CREATE TABLE contact_tags (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
SELECT app.enable_tenant_rls('contact_tags');
