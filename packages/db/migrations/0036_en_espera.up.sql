-- 0036 · Poner una conversación «en espera».
--
-- ## El problema que resuelve
--
-- Hay clientes a los que no se quiere contestar ahora —el que discute cada
-- precio, el que escribe a las tres de la mañana, el que ya dijo que no—, y
-- hasta hoy solo había dos gestos: dejarla abierta (sigue contando como «sin
-- responder» y el panel deja de significar nada) o cerrarla (el bot vuelve a
-- hablarle, que es justo lo que no se quiere).
--
-- «En espera» es el gesto que faltaba: sale de la bandeja de pendientes y el
-- bot se calla, pero la conversación no se cierra.
--
-- ## Por qué una columna nueva y no reutilizar `human_reply_at`
--
-- Poner `human_reply_at` callaría al bot con una línea de código, pero
-- significa «una persona respondió», y en una conversación que nadie contestó
-- sería mentira: la bandeja diría que está atendida cuando el cliente sigue
-- esperando. Una marca que miente se descubre tarde y en el peor sitio.
--
-- ## Por qué no es `snoozed_until`
--
-- Aplazar es un recordatorio —«vuelve a esto el jueves»— y tiene fecha. Esto
-- no tiene fecha ni la quiere: dura hasta que alguien la retome o la cierre.
ALTER TABLE conversations ADD COLUMN on_hold_at timestamptz;

-- Índice parcial: las que están en espera son pocas, y es la condición por la
-- que pregunta la puerta de envío antes de dejar arrancar un bot.
CREATE INDEX conversations_en_espera_idx ON conversations (tenant_id, on_hold_at)
  WHERE on_hold_at IS NOT NULL;
