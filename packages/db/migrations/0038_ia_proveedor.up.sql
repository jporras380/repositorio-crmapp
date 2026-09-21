-- 0038 · La IA asistida deja de ser solo Claude.
--
-- El hotel elige su proveedor y paga su propia cuenta (BYOK, P-11). Hasta hoy
-- solo había uno, así que el proveedor estaba implícito en el nombre del
-- modelo.
--
-- ## Por qué una columna y no deducirlo del modelo
--
-- «gemini-2.5-pro» delata a Google, sí. Pero los nombres de modelo los escribe
-- el usuario —tienen que poder, o la lista envejece y obliga a desplegar el
-- CRM para usar el modelo que salió ayer— y el primer modelo afinado que
-- alguien llame `hotel-v2` rompería la adivinanza. Guardarlo explícito cuesta
-- una columna y la quita para siempre.
--
-- Las claves NO se tocan: cada proveedor guarda la suya en `tenant_secrets`
-- con su propio `kind`, así que quien ya tenía la de Anthropic la conserva y
-- puede probar otro sin perderla.
ALTER TABLE ai_settings
  ADD COLUMN provider text NOT NULL DEFAULT 'anthropic';

-- Lo que ya existía es de Anthropic: era el único que había.
ALTER TABLE ai_settings
  ADD CONSTRAINT ai_settings_provider_ck
  CHECK (provider IN ('anthropic', 'google', 'openai', 'xai'));

-- Y la tabla de secretos tiene que admitir las claves de los otros tres. El
-- CHECK de 0025 solo conocía la de Anthropic, porque era el único proveedor.
-- Es una lista cerrada a propósito: `kind` es texto libre, y una errata
-- —`googl_api_key`— guardaría la clave donde nadie la busca sin fallar en
-- ningún sitio.
ALTER TABLE tenant_secrets DROP CONSTRAINT tenant_secrets_kind_check;
ALTER TABLE tenant_secrets
  ADD CONSTRAINT tenant_secrets_kind_check
  CHECK (kind IN ('anthropic_api_key', 'google_api_key', 'openai_api_key', 'xai_api_key'));
