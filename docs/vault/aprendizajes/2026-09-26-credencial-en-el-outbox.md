---
estado: vivo
fecha: 2026-09-26
modulo: seguridad
tags: [aprendizaje, seguridad, outbox, invitaciones]
---

# Una credencial esperando a un consumidor que nunca iba a llegar

El token de invitación se guardaba **en claro** dentro de `outbox.payload`, en
una tabla que nadie limpia, desde el día que PR-94 puso las invitaciones en
pantalla. Seis filas en la base de desarrollo. **Una seguía siendo usable.**

## El comentario que lo tapaba

```ts
// El token va en el evento porque el correo lo necesita. Es la única
// copia en claro que sobrevive a esta función, y vive en una tabla que
// el relay purga al publicar.
payload: { para: datos.email, rol: datos.rol, token },
```

Tres frases, dos falsas:

1. **«Porque el correo lo necesita.»** Ese correo no existe. Y no es que
   estuviera pendiente: en PR-94 se decidió a propósito **no construirlo** —la
   invitación se pasa copiando el enlace, justo para no montar un proveedor de
   envío con su dominio verificado y su coste recurrente—. El token esperaba a
   un consumidor que ya se había decidido que no iba a existir.
2. **«El relay purga al publicar.»** El relay hace
   `UPDATE outbox SET published_at = now()`. No borra nada. Nada borra nada.

La primera frase era verdad cuando se escribió, en fase 0, cuando el correo
todavía era el plan. Dejó de serlo sin que nadie volviera a leer el comentario.

## Cómo apareció

No lo buscaba. Estaba comprobando qué eventos del outbox no tienen consumidor
—una familia parecida a la que persiguen las guardas— y al contar consumidores
de `invitacion.creada` salió «1». Ese 1 era **el registro de auditoría con el
mismo nombre**, no un consumidor.

Al mirar por qué un evento sin consumidor llevaba carga útil, apareció el
token. La pregunta que lo destapó no fue «¿hay secretos en la base?» sino
**«¿por qué esto guarda algo si nadie lo lee?»**.

## Lo que sí estaba bien, y por qué importa decirlo

- `outbox` tiene **RLS forzada**: el token nunca salió del inquilino.
- La invitación caduca a los siete días.
- `invitations.token_hash` guarda el `sha256`, que es lo correcto.

O sea: el diseño sabía que esto era una credencial y la trataba como tal **en
la tabla de al lado**. El fallo no fue no saberlo; fue una copia olvidada.

Eso acota el daño —dentro de la cuenta, y con caducidad— pero no lo excusa: era
una llave en texto plano con la que se entra con el rol que se hubiera
invitado, guardada indefinidamente.

## Por qué la protección es un test y no una guarda

La tentación era una sexta guarda estática que buscara claves sospechosas en
las llamadas a `escribirEnOutbox`. No sirve: los payloads se arman con
variables, y un escaneo del código se engaña solo con
`payload: { ...datos }`.

Se prueba **lo que acaba en la base**, que es lo que importó:

```sql
SELECT DISTINCT o.event_type, k
  FROM outbox o, LATERAL jsonb_object_keys(o.payload) k
 WHERE lower(k) = ANY($1::text[])   -- token, secret, password, apiKey…
```

Dos tests: uno mira la invitación concreta, y otro echa **la red ancha sobre
todos los eventos**. El segundo es el que importa, porque el daño no fue el
token concreto sino que nadie estaba mirando esa tabla.

Están comprobados al revés: devolviendo el token al payload, los dos se ponen
rojos.

## Lo que queda anotado

**Nada purga el outbox.** Hoy no guarda credenciales, pero guarda cuerpos de
mensajes de huéspedes (`mensaje.enviar` lleva la petición entera) y crece sin
tope. Una política de retención es trabajo aparte y con nombre, no algo que
entre de refilón en este arreglo.
