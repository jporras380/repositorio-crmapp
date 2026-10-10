-- Reversa de 0054. Los canales conectados con la plataforma SIGUEN
-- funcionando: su token y su clave secreta están guardados como los de
-- cualquier otro. Lo que se pierde es saber cuáles eran, y los PIN de
-- registro —se borran antes de devolver el CHECK, o la reversa fallaría
-- contra las filas que ella misma permitió crear—. Un PIN perdido se
-- restablece en el Administrador de WhatsApp.
DELETE FROM channel_secrets WHERE kind = 'pin';
ALTER TABLE channel_secrets DROP CONSTRAINT channel_secrets_kind_check;
ALTER TABLE channel_secrets
  ADD CONSTRAINT channel_secrets_kind_check
  CHECK (kind IN ('access_token', 'app_secret', 'webhook_secret', 'refresh_token'));
ALTER TABLE channel_accounts DROP COLUMN IF EXISTS connected_via;
