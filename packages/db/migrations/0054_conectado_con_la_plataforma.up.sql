-- 0054 · Canales conectados con la app de la plataforma.
--
-- Hasta aquí cada hotel traía su propia app de Meta y pegaba su token y su
-- clave secreta (ADR-004, «BYO»). Desde ADR-015 puede además conectar con la
-- app de la PLATAFORMA: inicio de sesión de Meta, o el QR de coexistencia de
-- WhatsApp Business. Las dos formas conviven.
--
-- `connected_via` dice cuál fue. No cambia cómo se verifica un webhook ni cómo
-- se envía —la clave secreta y el token se guardan igual, cifrados, por
-- cuenta—, pero hace falta saberlo por dos motivos:
--
-- 1. Si la plataforma rota la clave secreta de su app, hay que reescribirla
--    en todas las cuentas `plataforma`, y solo en esas.
-- 2. La pantalla no debe ofrecer «pega un token nuevo» a quien conectó con un
--    botón: no tiene ningún token que pegar.
ALTER TABLE channel_accounts
  ADD COLUMN connected_via text NOT NULL DEFAULT 'credenciales'
    CHECK (connected_via IN ('credenciales', 'plataforma'));

COMMENT ON COLUMN channel_accounts.connected_via IS
  'credenciales: el cliente pegó token y clave de su app (ADR-004). plataforma: inicio de sesión o QR con la app de la plataforma (ADR-015).';

-- El PIN de verificación en dos pasos con que se registra un número NUEVO en
-- la Cloud API. Lo genera la plataforma y Meta lo pide para volver a
-- registrar el número: perderlo obliga al cliente a restablecerlo a mano en
-- el Administrador de WhatsApp. Un número en coexistencia no lo necesita.
ALTER TABLE channel_secrets DROP CONSTRAINT channel_secrets_kind_check;
ALTER TABLE channel_secrets
  ADD CONSTRAINT channel_secrets_kind_check
  CHECK (kind IN ('access_token', 'app_secret', 'webhook_secret', 'refresh_token', 'pin'));
