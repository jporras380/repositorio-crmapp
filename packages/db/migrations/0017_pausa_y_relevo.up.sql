-- 0017 · El bot aprende a esperar sin que le hablen, y a callarse cuando entra
-- una persona.
--
-- Dos cambios pequeños de esquema para dos comportamientos que hasta hoy no
-- existían:
--
-- 1. `wait_for = 'pausa'`. Hasta ahora una ejecución dormida solo podía estar
--    esperando la respuesta del contacto. El nodo `pausa` duerme SIN esperar
--    respuesta: un entrante no la reanuda, solo el temporizador. La diferencia
--    no es cosmética — es justo la columna por la que el motor decide si un
--    mensaje del contacto despierta a este bot o dispara otro.
--
-- 2. `conversations.human_reply_at`: cuándo respondió una persona en este hilo.
--    Podría deducirse de `messages` —hay un saliente con `sent_by='human'`—
--    pero la pregunta no es «¿alguna vez?», es «¿lo lleva alguien AHORA?», y
--    para eso hace falta un instante que se borre al cerrar la conversación.
--    Se intentó sin columna, anclando en `closed_at`, y no vale: reabrir desde
--    la bandeja lo pone a NULL y reabrir por un entrante no, así que el mismo
--    hilo daba dos respuestas distintas según por dónde se hubiera reabierto.
--
--    Quien la pone es la puerta de envío; quien la borra es cerrar la
--    conversación. Si algún día alguien cierra sin borrarla, el fallo es que
--    el bot se queda callado de más — el lado correcto en el que fallar.
--
-- 3. `cancelled` con motivo. La columna `error` ya existía; lo que se añade es
--    el índice por conversación con el que la puerta de envío encuentra, en la
--    misma transacción en la que un agente pulsa «Enviar», las ejecuciones
--    vivas que hay que apagar. Sin índice, ese SELECT extra estaría en el
--    camino caliente de cada envío humano.

ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_wait_for_check;
ALTER TABLE flow_runs
  ADD CONSTRAINT flow_runs_wait_for_check CHECK (wait_for IN ('respuesta', 'pausa'));

COMMENT ON COLUMN flow_runs.wait_for IS
  'respuesta: un entrante del contacto la reanuda. pausa: solo la reanuda el reloj.';

-- Las vivas de UNA conversación. El índice único `flow_runs_vivas_uq` no sirve
-- aquí: incluye `flow_id` y es único, así que no cubre «dame todas las vivas de
-- esta conversación» sin leer la tabla.
CREATE INDEX flow_runs_vivas_por_conversacion_idx ON flow_runs (conversation_id)
  WHERE status IN ('running', 'waiting');

ALTER TABLE conversations ADD COLUMN human_reply_at timestamptz;

COMMENT ON COLUMN conversations.human_reply_at IS
  'Instante en que una persona respondió en este hilo. Mientras no sea NULL, ningún bot arranca aquí. Lo pone la puerta de envío y lo borra cerrar la conversación.';
