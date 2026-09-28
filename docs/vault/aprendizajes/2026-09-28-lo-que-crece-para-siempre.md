---
estado: vivo
fecha: 2026-09-28
modulo: infra
tags: [aprendizaje, retencion, outbox, idempotencia]
---

# Escribir la política no es aplicarla

`message_keys` llevaba desde la migración 0004 con **tres cosas escritas** y
ninguna hecha:

1. La política, en un comentario de la propia migración: *«Retención propia de
   90 días: más allá, Meta ya no reenvía nada y la fila no protege de nada.»*
2. El índice para aplicarla: `message_keys_purga_idx ON (created_at)`. Se llama
   **purga**.
3. El tipo de tarea en `colas.ts`: `'purgar_message_keys'`.

Tres declaraciones apuntando a un trabajo que nadie hacía, durante meses. El
worker recibía la tarea y caía en
`log.warn('tarea de mantenimiento sin implementar')` — salvo que nadie la
programaba, así que ni eso.

`outbox` estaba peor: ni política, ni índice, ni tarea. El relay marca
`published_at` y la fila se queda.

## Cómo apareció

Persiguiendo otra cosa. El token de invitación en claro (0046) llevaba días en
`outbox` **porque nada limpia esa tabla**; al escribir ese arreglo quedó
anotado que la retención era trabajo aparte. Esto es ese trabajo.

O sea: un fallo de seguridad y un fallo de mantenimiento con la misma raíz —
una tabla a la que nadie miraba.

## La decisión que importa: funciones, no un GRANT

Lo barato era `GRANT DELETE ON outbox TO crmapp_relay` y un `DELETE` en el
worker. Se descartó.

Con ese GRANT, el rol del relay puede borrar **cualquier fila** del outbox,
incluidas las que todavía no se han publicado. Eso no es un riesgo teórico: un
error en un `WHERE` del worker —o el worker comprometido— borraría trabajo sin
entregar, que son mensajes que un cliente cree enviados.

Con `SECURITY DEFINER`, el relay no gana el permiso: gana **poder llamar a la
función**. Y lo que la función borra está escrito en la base, en una migración
revisable, no en un `DELETE` que cualquiera puede editar:

- Publicadas, y solo publicadas.
- Más viejas que el plazo.
- Como mucho un lote.

Es el patrón que este proyecto ya usaba para `ensure_partitions_ahead` (0013),
y ahora sé por qué se eligió.

## Los dos que nunca se borran

Son los tests que justifican todo lo anterior:

- **Un evento sin publicar.** Es trabajo por entregar, por viejo que sea.
- **Una carta muerta** — agotó `attempts` y nunca se publicó. Es lo *único* que
  queda para saber qué falló. Borrarla es tapar el fallo, no limpiarlo.

Los dos casos se protegen con la misma condición (`published_at IS NOT NULL`),
y los dos tienen su test.

## Los suelos van en la función, no en quien la llama

`purgar_message_keys` se niega a bajar de 90 días. No es una preferencia de
almacenamiento: bajar de ahí convierte un reenvío tardío de Meta en **un
mensaje duplicado para un huésped**.

Si el suelo viviera en el worker, sería un número que alguien cambia un martes
sin saber qué compra. En la función, cambiarlo exige una migración.

## Lo que salió de paso

`refrescar_vistas` era un tipo de tarea muerto: no hay ni una vista
materializada en el esquema. Fuera.

## Lo que sigue sin retención, a propósito

`messages`, `inbound_events`, `usage_events` y `audit_log` **están
particionados por mes**, así que su retención es tirar particiones, no borrar
filas. Es otra decisión —y de negocio, no de infraestructura: cuánto historial
de conversaciones guarda el hotel lo decide el hotel.
