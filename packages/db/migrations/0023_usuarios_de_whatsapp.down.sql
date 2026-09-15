-- Reversa de 0023. Se pierden los BSUID y nombres de usuario guardados; las
-- identidades creadas SIN número conservan el BSUID en `external_user_id`,
-- así que siguen resolviéndose.
DROP INDEX IF EXISTS contact_identities_provider_user_idx;
ALTER TABLE contact_identities
  DROP COLUMN IF EXISTS username,
  DROP COLUMN IF EXISTS provider_user_id;
