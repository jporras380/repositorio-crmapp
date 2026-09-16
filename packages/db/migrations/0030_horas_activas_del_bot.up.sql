-- 0030 · A qué horas puede hablar cada bot.
--
-- El hotel ya tiene horario (0027) y avisa «estamos cerrados» de madrugada,
-- pero los bots no lo miraban: el mismo mensaje de las 3 de la mañana podía
-- recibir el aviso Y el saludo del bot. Para el cliente son dos voces que no
-- se hablan entre ellas, que es justo lo que el relevo (PR-32) existe para
-- evitar.
--
-- ## Por qué por bot y no por cuenta
--
-- Porque los dos casos son reales y opuestos: un bot que califica un lead y lo
-- pasa a una persona **solo sirve con gente delante** (`solo_abierto`), y un
-- bot que contesta las preguntas de siempre **solo hace falta cuando no hay
-- nadie** (`solo_cerrado`). Una bandera por cuenta obligaría a elegir uno.
--
-- ## Por qué el valor por defecto es 'siempre'
--
-- Es lo que hacen hoy todos los bots publicados. Cambiárselo con una migración
-- sería reescribirles el guion a espaldas de quien los montó, y el síntoma
-- —un bot que deja de contestar— no se parece en nada a la causa.

ALTER TABLE flows
  ADD COLUMN active_hours text NOT NULL DEFAULT 'siempre';

ALTER TABLE flows
  ADD CONSTRAINT flows_active_hours_check
    CHECK (active_hours IN ('siempre', 'solo_abierto', 'solo_cerrado'));
