-- 0025 · IA asistida con la clave del propio cliente (P-11: BYOK, solo asistida).
--
-- Dos tablas y ninguna columna nueva en `messages`: `sent_by` y
-- `ai_generated` existen desde 0004, pensadas justo para esto.
--
-- ## Por qué la clave va en su propia tabla
--
-- `channel_secrets` cuelga de una cuenta de canal y la clave de IA es de la
-- cuenta entera. Meterla allí obligaría a inventar una cuenta de canal falsa.
-- Mismo formato de cifrado (envelope, ARCH §11): el texto en claro no toca
-- la base.
--
-- ## Por qué la IA empieza apagada
--
-- Activarla hace que el contenido de las conversaciones salga hacia un
-- proveedor de terceros con la clave del hotel. Eso lo decide una persona
-- con permiso de administración, no un valor por defecto.

CREATE TABLE ai_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT false,
  -- Id de modelo de Anthropic. Se valida contra el proveedor al guardar la clave.
  model         text NOT NULL DEFAULT 'claude-opus-5',
  -- Contexto del negocio que se añade a cada sugerencia: tono, políticas,
  -- horarios. Lo escribe el hotel; el catálogo de habitaciones se añade solo.
  instructions  text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 8000),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('ai_settings');

CREATE TABLE tenant_secrets (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text  NOT NULL CHECK (kind IN ('anthropic_api_key')),
  ciphertext   bytea NOT NULL,
  dek_wrapped  bytea NOT NULL,
  key_version  int   NOT NULL,
  rotated_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind)
);
SELECT app.enable_tenant_rls('tenant_secrets');
