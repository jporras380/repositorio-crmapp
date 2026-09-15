-- 0024 · Facebook Messenger y comentarios de página como canal.
--
-- Solo se amplía la lista de canales permitidos. Nada más cambia de forma:
-- una página de Facebook es una `channel_account` (external_id = id de la
-- página), quien escribe es una `contact_identity` (external_user_id = PSID,
-- el id de usuario propio de la página) y los comentarios cuelgan de hilos
-- `comment_thread`, igual que en Instagram.
--
-- `inbound_events` está particionada: la restricción del padre se propaga a
-- todas sus particiones.

ALTER TABLE channel_accounts DROP CONSTRAINT channel_accounts_channel_check;
ALTER TABLE channel_accounts ADD CONSTRAINT channel_accounts_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'facebook', 'tiktok'));

ALTER TABLE contact_identities DROP CONSTRAINT contact_identities_channel_check;
ALTER TABLE contact_identities ADD CONSTRAINT contact_identities_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'facebook', 'tiktok'));

ALTER TABLE inbound_events DROP CONSTRAINT inbound_events_channel_check;
ALTER TABLE inbound_events ADD CONSTRAINT inbound_events_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'facebook', 'tiktok'));
