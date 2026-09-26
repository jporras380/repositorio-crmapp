-- 0046 · Sacar del outbox los tokens de invitación en claro.
--
-- ## Qué pasaba
--
-- `invitacion.creada` guardaba el token de la invitación **en claro** dentro
-- de `outbox.payload`, con un comentario que decía que iba ahí «porque el
-- correo lo necesita» y que «el relay purga al publicar». Las dos cosas eran
-- falsas:
--
-- 1. Ese correo no existe. PR-94 decidió a propósito pasar la invitación
--    copiando el enlace, para no montar un proveedor de envío. El token
--    esperaba a un consumidor que no iba a llegar.
-- 2. El relay no purga: marca `published_at` y la fila se queda para siempre.
--    Nada limpia el outbox.
--
-- Resultado: una credencial en claro, indefinidamente, justo al lado de
-- `invitations.token_hash`, que la guarda hasheada a propósito.
--
-- ## Qué tan grave
--
-- Menos de lo que parece, y más de lo que debería. `outbox` tiene RLS FORZADA,
-- así que no se escapa del inquilino, y el token caduca a los siete días. Pero
-- dentro de la cuenta era una llave escrita en texto plano que permite entrar
-- con el rol que se hubiera invitado, y en la base de desarrollo había seis,
-- **una todavía usable**.
--
-- ## Qué hace esta migración
--
-- Quita la clave `token` de los eventos ya escritos. El evento se queda: es el
-- registro de que se invitó a alguien, y eso no molesta a nadie. Lo que
-- desaparece es la credencial.
UPDATE outbox
   SET payload = payload - 'token'
 WHERE event_type = 'invitacion.creada'
   AND payload ? 'token';
