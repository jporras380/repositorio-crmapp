-- Reversa de 0018. El embudo entero es aditivo: nada de lo anterior depende de
-- él, así que volver atrás es tirar cinco tablas. Los leads se pierden —son
-- exactamente los datos que esta migración creó— y las conversaciones, los
-- contactos y los mensajes quedan intactos, que es lo que importa.
DROP FUNCTION IF EXISTS app.sembrar_embudo(uuid);
DROP TABLE IF EXISTS lead_events;
DROP TABLE IF EXISTS lead_tags;
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS pipeline_stages;
DROP TABLE IF EXISTS pipelines;
