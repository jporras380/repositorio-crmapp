-- 0032 · Fusionar contactos duplicados (P-08, la deuda más antigua).
--
-- El mismo huésped escribe por WhatsApp en marzo y por Instagram en julio, o
-- llega por dos números. Hoy son dos fichas, y el agente atiende a medias
-- porque la otra mitad del historial está en la otra.
--
-- `contact_merges` existía desde la fase 0 y no la usaba nadie. Le faltaban
-- dos cosas para que la fusión fuera algo más que un borrado con historia:
--
-- ## `contacts.merged_into`
--
-- El contacto absorbido NO se borra. Se marca a dónde fue, y los listados lo
-- esconden. Borrarlo dejaría `contact_merges.source_contact_id` apuntando al
-- vacío y haría imposible deshacer.
--
-- ## `contact_merges.moved`
--
-- Qué filas se movieron exactamente, por tabla. Sin esto, deshacer sería
-- adivinar: después de fusionar no hay forma de saber cuál de las diez
-- conversaciones del destino venía del origen. `reverted_at` estaba en el
-- esquema desde el principio y sin esta columna nunca habría podido usarse.

ALTER TABLE contacts ADD COLUMN merged_into uuid REFERENCES contacts (id);

ALTER TABLE contact_merges ADD COLUMN moved jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Los listados filtran por «no fusionado»: es la consulta más frecuente de la
-- pantalla de Clientes y conviene que no recorra los absorbidos.
CREATE INDEX contacts_vivos_idx ON contacts (tenant_id) WHERE merged_into IS NULL;

-- Para proponer duplicados por nombre: «Ana García» y «ana garcia» son la
-- misma persona escrita por dos agentes distintos. `unaccent` es una extensión
-- contrib estándar; no se indexa con ella, así que su falta de inmutabilidad
-- no estorba.
CREATE EXTENSION IF NOT EXISTS unaccent;
