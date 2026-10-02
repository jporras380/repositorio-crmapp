-- 0053 · Mensajes con opciones para pulsar (botones y listas).
--
-- Los bots de WhatsApp pueden preguntar con botones o con una lista
-- (PR-112). Se guardan como su propio tipo, y no como texto, porque la
-- bandeja tiene que enseñar lo que de verdad le llegó al huésped: unos botones
-- no son un párrafo. El cuerpo va en `body` —lo que lee la búsqueda y la vista
-- previa— y las opciones en `payload.interactivo`.
--
-- Cuando el canal no tiene botones (Instagram, Messenger), el mensaje se
-- guarda como `text` con las opciones escritas: es lo que se envió.
--
-- Solo cambia un CHECK. En una tabla particionada se propaga a todas las
-- particiones.
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text', 'image', 'video', 'audio', 'document', 'location', 'sticker',
                  'template', 'system', 'interactive'));
