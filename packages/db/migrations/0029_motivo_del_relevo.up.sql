-- 0029 · Por qué esta conversación necesita una persona.
--
-- Hasta hoy el relevo era mudo en las dos direcciones: cuando un agente
-- escribía, los bots se callaban (`relevo.ts`), pero cuando el bot se rendía no
-- había forma de decirlo. El flujo terminaba y la conversación quedaba en la
-- bandeja igual que las demás, sin nada que la distinguiera de las que nadie
-- espera.
--
-- Dos columnas en `conversations`, no una tabla: es un estado ACTUAL de la
-- conversación («pide una persona»), no un historial. El historial ya existe y
-- es `flow_run_steps`, donde cada relevo queda con su paso y su hora.
--
-- Se limpian solas cuando una persona contesta: lo hace la puerta de envío, en
-- la misma sentencia que ya marca `human_reply_at`. Que la atendieran es
-- exactamente lo que el aviso pedía.

ALTER TABLE conversations
  ADD COLUMN handoff_reason text,
  ADD COLUMN handoff_at timestamptz;

-- Índice parcial: la bandeja filtra «pide una persona», que son unas pocas
-- filas entre muchas. Un índice completo aquí ocuparía por cada conversación
-- que NO interesa.
CREATE INDEX conversations_relevo_idx
  ON conversations (tenant_id, handoff_at DESC)
  WHERE handoff_reason IS NOT NULL;
