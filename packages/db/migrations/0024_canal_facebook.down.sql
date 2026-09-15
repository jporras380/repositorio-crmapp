-- Reversa de 0024. NO borra datos: si ya hay filas de Facebook, la restricción
-- vuelve como NOT VALID. Impide filas nuevas de Facebook, pero conserva las
-- existentes en vez de fallar o destruirlas. Borrarlas sería decisión de una
-- persona, no de una migración.

ALTER TABLE inbound_events DROP CONSTRAINT inbound_events_channel_check;
ALTER TABLE inbound_events ADD CONSTRAINT inbound_events_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'tiktok')) NOT VALID;

ALTER TABLE contact_identities DROP CONSTRAINT contact_identities_channel_check;
ALTER TABLE contact_identities ADD CONSTRAINT contact_identities_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'tiktok')) NOT VALID;

ALTER TABLE channel_accounts DROP CONSTRAINT channel_accounts_channel_check;
ALTER TABLE channel_accounts ADD CONSTRAINT channel_accounts_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'tiktok')) NOT VALID;
