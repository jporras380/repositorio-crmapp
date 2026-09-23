-- Reversa de 0044. Los mensajes que solo llevaban captura se quedarían sin
-- nada que decir, así que se les pone un texto antes de volver a exigirlo.
UPDATE support_messages
   SET body = '(captura adjunta)'
 WHERE length(btrim(body)) = 0;

ALTER TABLE support_messages DROP CONSTRAINT IF EXISTS support_messages_algo_que_decir_ck;
ALTER TABLE support_messages
  ADD CONSTRAINT support_messages_body_check
  CHECK (length(btrim(body)) BETWEEN 1 AND 4000);

ALTER TABLE support_messages DROP COLUMN IF EXISTS media_asset_id;
