-- Reversa de 0025. Se pierden los ajustes de IA y la clave cifrada del
-- cliente; los mensajes marcados como generados por IA se conservan (la marca
-- vive en `messages` desde 0004).
DROP TABLE IF EXISTS tenant_secrets;
DROP TABLE IF EXISTS ai_settings;
