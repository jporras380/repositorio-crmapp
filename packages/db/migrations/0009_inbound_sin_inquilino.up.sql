-- 0009 · Registrar webhooks de cuenta desconocida.
--
-- Cuando llega un webhook cuya cuenta no reconocemos —una desconexion a
-- medias, un secreto rotado, una configuracion apuntando aqui por error— hay
-- que dejar rastro. Sin el, el sintoma es "los mensajes no llegan" y no hay
-- forma de distinguirlo de un fallo de red.
--
-- Pero esa fila no tiene inquilino, y la politica normal compara
-- `tenant_id = app.current_tenant_id()`: con NULL a los dos lados el resultado
-- es NULL, no TRUE, asi que la insercion se rechaza.
--
-- La politica de abajo permite insertar filas SIN inquilino. Es seguro porque
-- esas filas son invisibles para todos: ningun inquilino puede leerlas, ya que
-- `NULL = <su id>` tampoco es TRUE. Son de solo escritura desde la aplicacion
-- y solo las ve quien entra con el rol de migraciones, que es exactamente el
-- caso de uso: diagnostico por parte de un operador.

CREATE POLICY inbound_sin_inquilino ON inbound_events
  FOR INSERT
  WITH CHECK (tenant_id IS NULL);

COMMENT ON POLICY inbound_sin_inquilino ON inbound_events IS
  'Permite registrar webhooks de cuenta desconocida. Las filas resultantes no las lee ningun inquilino.';
