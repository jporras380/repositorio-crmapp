-- Reversa de 0043. Se pierde el historial de lo que se habló con cada cliente.
REVOKE ALL ON support_messages FROM crmapp_soporte;
DROP POLICY IF EXISTS operador_marca_leido ON support_messages;
DROP POLICY IF EXISTS operador_lee_soporte ON support_messages;
DROP TABLE IF EXISTS support_messages;
