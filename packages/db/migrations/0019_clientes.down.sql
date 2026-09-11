-- Reversa de 0019. Solo se pierden los datos que esta migración permitió
-- guardar —correo, ciudad, origen, observaciones—; los contactos, sus
-- identidades y sus conversaciones quedan intactos.
DROP INDEX IF EXISTS contacts_listado_idx;
DROP INDEX IF EXISTS contacts_email_uq;
DROP INDEX IF EXISTS contacts_telefono_uq;

ALTER TABLE contacts
  DROP COLUMN IF EXISTS anonymized_at,
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS guest_type,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS photo_url,
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS phone;
