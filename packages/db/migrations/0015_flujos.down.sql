-- Reversa de 0015. Pierde los flujos y su historial de ejecuciones: el grafo
-- se puede volver a crear, pero el log de por qué el bot dijo lo que dijo no
-- se recupera. Se acepta porque todavía no hay flujos en producción.
DROP TABLE IF EXISTS flow_run_steps;
DROP TABLE IF EXISTS flow_runs;
DROP TABLE IF EXISTS flow_triggers;
DROP TABLE IF EXISTS flow_versions;
DROP TABLE IF EXISTS flows;
