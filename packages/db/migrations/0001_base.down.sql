-- Reversa de 0001.
--
-- NO se hace DROP ROLE crmapp_app: los roles son del clúster, no de la base
-- de datos, y pueden tener permisos en otras. Revertir una migración no debe
-- poder romper una base vecina.
DROP FUNCTION IF EXISTS app.ensure_partitions_ahead(int);
DROP FUNCTION IF EXISTS app.ensure_partition(regclass, date, boolean, text);
DROP FUNCTION IF EXISTS app.enable_tenant_rls(regclass);
DROP FUNCTION IF EXISTS app.current_tenant_id();
DROP SCHEMA IF EXISTS app CASCADE;
