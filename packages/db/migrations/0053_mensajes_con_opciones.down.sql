-- Reversa de 0053. Los mensajes con opciones pasan a `text` antes de devolver
-- el CHECK a como estaba: si no, la reversa falla contra las filas que ella
-- misma permitió crear. Se conserva el texto; las opciones siguen en
-- `payload.interactivo`, aunque la bandeja ya no las pinte.
UPDATE messages SET type = 'text' WHERE type = 'interactive';
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text', 'image', 'video', 'audio', 'document', 'location', 'sticker',
                  'template', 'system'));
