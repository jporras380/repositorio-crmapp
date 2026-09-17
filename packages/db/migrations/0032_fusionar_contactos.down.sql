-- Reversa de 0032. Los contactos absorbidos vuelven a aparecer en los
-- listados: no se pierde nada, se deja de saber que estaban fusionados.
DROP INDEX IF EXISTS contacts_vivos_idx;
ALTER TABLE contact_merges DROP COLUMN IF EXISTS moved;
ALTER TABLE contacts DROP COLUMN IF EXISTS merged_into;
