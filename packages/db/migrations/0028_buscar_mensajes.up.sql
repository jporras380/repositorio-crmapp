-- 0028 · Buscar dentro del texto de los mensajes.
--
-- Hasta hoy la búsqueda de la bandeja era por contacto (nombre, @ o teléfono)
-- porque `messages` está particionada y un `ILIKE` sobre ella recorre meses
-- enteros. Con un índice de texto, buscar «bungalow» o «Yape» y encontrar la
-- conversación pasa a costar milisegundos.
--
-- ## Por qué una columna generada y no un índice sobre la expresión
--
-- Un índice sobre `to_tsvector(...)` obliga a repetir la MISMA expresión en
-- cada consulta para que se use; una letra distinta y el índice se ignora en
-- silencio, que es la peor forma de fallar. La columna generada la calcula
-- PostgreSQL y la consulta solo la compara.
--
-- ## Por qué 'spanish' y no 'simple'
--
-- El hotel atiende en español: con 'spanish', «reservas» encuentra «reserva»
-- y «reservar». Un mensaje en otro idioma sigue encontrándose por sus
-- palabras exactas, que es lo que hace 'simple'. El precio de elegir es
-- pequeño y la ganancia diaria es grande.
--
-- Se aplica al padre y se propaga a todas las particiones, presentes y
-- futuras (las crea `app.ensure_partition`).

-- `btree_gin` permite meter `tenant_id` (uuid) en el MISMO índice GIN que el
-- texto. Sin ella harían falta dos índices y PostgreSQL tendría que cruzarlos.
CREATE EXTENSION IF NOT EXISTS btree_gin;

ALTER TABLE messages
  ADD COLUMN search tsvector
    GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(body, ''))) STORED;

-- GIN es el índice de texto: pesa más al escribir que BTree, pero es el que
-- responde a «contiene esta palabra».
CREATE INDEX messages_busqueda_idx ON messages USING gin (tenant_id, search);
