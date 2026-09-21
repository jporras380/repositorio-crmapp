-- Reversa de 0038. Quien hubiera elegido otro proveedor vuelve a Claude; su
-- clave sí se pierde aquí, y hay que decirlo: el CHECK vuelve a admitir solo
-- la de Anthropic, así que las de Google, OpenAI y xAI se borran. No hay dónde
-- guardarlas mientras la restricción no las admita, y dejarlas rompería la
-- migración entera.
DELETE FROM tenant_secrets
 WHERE kind IN ('google_api_key', 'openai_api_key', 'xai_api_key');

ALTER TABLE tenant_secrets DROP CONSTRAINT tenant_secrets_kind_check;
ALTER TABLE tenant_secrets
  ADD CONSTRAINT tenant_secrets_kind_check CHECK (kind IN ('anthropic_api_key'));

ALTER TABLE ai_settings DROP CONSTRAINT IF EXISTS ai_settings_provider_ck;
ALTER TABLE ai_settings DROP COLUMN IF EXISTS provider;
