-- Reversa de 0006.
--
-- No se hace DROP ROLE: los roles son del clúster y pueden tener permisos en
-- otras bases. Revertir una migración no debe poder romper una base vecina.
DROP POLICY IF EXISTS relay_todo ON outbox;
REVOKE ALL ON outbox FROM crmapp_relay;
