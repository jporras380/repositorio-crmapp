-- 0014 · Saber si el proveedor nos envía de verdad los webhooks.
--
-- Lección del 2026-09-09, con tráfico real: configurar la URL del webhook en
-- la app de Meta NO hace que lleguen los mensajes. La cuenta de WhatsApp
-- Business (WABA) tiene su propia lista de apps suscritas, y la del número de
-- prueba venía atada a la app interna del panel de Meta. El canal aparecía
-- «conectado» y no recibía nada, sin ningún error en ninguna parte.
--
-- `null` = no se sabe (cuentas anteriores a esta migración, o canales cuyo
-- proveedor no tiene este concepto). `false` es lo que hay que mostrar en
-- rojo: conectado pero sordo.
ALTER TABLE channel_accounts ADD COLUMN webhook_subscribed boolean;

COMMENT ON COLUMN channel_accounts.webhook_subscribed IS
  'La WABA (o equivalente) está suscrita a NUESTRA app. false = conectado pero no recibe.';
