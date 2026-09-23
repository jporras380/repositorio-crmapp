-- 0044 · Capturas en el chat de soporte.
--
-- Un problema de interfaz se explica en una captura y no en tres párrafos.
-- «No me sale el botón» y una imagen del botón que no sale son la misma
-- frase, pero solo una se entiende a la primera.
--
-- ## Por qué reutiliza `media_assets`
--
-- Ya existe todo: subida por URL firmada, deduplicación por sha256, límite de
-- tamaño, lista de tipos admitidos y descarga firmada a cinco minutos. Hacer
-- una segunda tubería para soporte sería mantener dos, y la segunda no
-- tendría ninguna de esas cosas hasta que a alguien le tocara añadírselas.
--
-- El medio es del INQUILINO, como cualquier otro: lo sube el cliente desde su
-- cuenta y vive bajo su RLS. Que soporte pueda verlo es un permiso aparte y
-- acotado, no una propiedad del archivo.
ALTER TABLE support_messages
  ADD COLUMN media_asset_id uuid REFERENCES media_assets (id) ON DELETE SET NULL;

-- El cuerpo deja de ser obligatorio CUANDO hay adjunto: mandar una captura
-- sin texto es una forma legítima de decir «mira esto», y obligar a escribir
-- algo solo produce mensajes que dicen «.».
ALTER TABLE support_messages DROP CONSTRAINT support_messages_body_check;
ALTER TABLE support_messages
  ADD CONSTRAINT support_messages_algo_que_decir_ck
  CHECK (
    length(btrim(body)) BETWEEN 1 AND 4000
    OR (media_asset_id IS NOT NULL AND length(body) <= 4000)
  );
