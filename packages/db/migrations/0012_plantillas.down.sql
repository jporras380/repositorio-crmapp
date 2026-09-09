-- Reversa de 0012. Sin datos en producción todavía; si los hubiera, esta
-- reversa perdería las plantillas sincronizadas (se recuperan sincronizando)
-- y las respuestas rápidas (no se recuperan).
DROP TABLE IF EXISTS wa_template_versions;
DROP TABLE IF EXISTS wa_templates;
DROP TABLE IF EXISTS quick_reply_versions;
DROP TABLE IF EXISTS quick_replies;
