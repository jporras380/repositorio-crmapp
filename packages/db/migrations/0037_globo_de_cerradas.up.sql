-- 0037 · Apagar el globo de «sin leer» en lo que ya estaba cerrado.
--
-- Desde PR-82, cerrar una conversación (o ponerla en espera) pone el contador
-- a cero: una conversación dada por terminada que sigue enseñando el globo
-- azul es un aviso que no lleva a ninguna parte, y el equipo aprende a
-- ignorarlo — que es la forma de que un día se ignore uno que sí importaba.
--
-- Eso vale para lo que se cierre a partir de ahora. Lo cerrado ANTES arrastra
-- su contador, y el usuario lo ve en pantalla: conversaciones cerradas con un
-- «1» encima.
--
-- ## Lo que esta migración no puede deshacer
--
-- La reversa NO devuelve los contadores: no hay dónde guardarlos. Se acepta
-- porque el número que se pierde ya era falso —decía «hay mensajes que nadie
-- ha visto» de un hilo que alguien leyó y cerró a mano— y porque no es un
-- dato del cliente: ni un mensaje, ni un contacto, ni una reserva. Es un
-- adorno de la lista que se recalcula solo con el siguiente entrante.
UPDATE conversations
   SET unread_count = 0
 WHERE unread_count > 0
   AND (status = 'closed' OR on_hold_at IS NOT NULL);
