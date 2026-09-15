-- 0023 · Contactos de WhatsApp que llegan sin número.
--
-- Meta asigna a cada usuario un id propio de cada negocio (BSUID, p. ej.
-- `PE.1349120865530274`) y lo manda en todos los webhooks de mensajes. Con los
-- nombres de usuario de WhatsApp, el número (`wa_id`/`from`) deja de venir
-- cuando la persona activó su nombre de usuario, no habló con el negocio en
-- 30 días y no está en su agenda. Hasta hoy la identidad se buscaba solo por
-- número: ese mensaje se habría descartado.
--
-- Aditiva: dos columnas nulas y un índice. Las identidades existentes siguen
-- con su número en `external_user_id`; el BSUID se les rellena solo cuando
-- vuelvan a escribir.

ALTER TABLE contact_identities
  -- Id de usuario propio del negocio que da el proveedor (BSUID en WhatsApp).
  -- Estable mientras la persona no cambie de número.
  ADD COLUMN provider_user_id text,
  -- Nombre de usuario público (sin «@»), cuando la persona lo tiene.
  ADD COLUMN username text;

CREATE UNIQUE INDEX contact_identities_provider_user_idx
  ON contact_identities (channel_account_id, provider_user_id)
  WHERE provider_user_id IS NOT NULL;
