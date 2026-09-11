---
estado: vivo
fecha: 2026-09-11
modulo: bandeja
tags: [bandeja, filtros, vistas, notas, atencion, kommo]
---

# Módulo — Bandeja

La pantalla que se mira ocho horas al día. API en `apps/api/src/bandeja/`, pantalla en `apps/web/src/pantallas/Bandeja/`. Migraciones `0004` (conversaciones y mensajes), `0010` (visibilidad) y `0020` (atención, aplazar y vistas).

![[2026-09-11-bandeja-filtros.png]]

## El estado de atención se DEDUCE, no se guarda

El encargo pedía una lista de estados —Nuevo, En atención, Esperando cliente, Seguimiento, Cerrado— y la forma obvia es una columna que el agente mantiene a mano. Es también la forma de que mienta: nadie se acuerda de marcar «esperando cliente» después de responder, y a los dos días el filtro no vale.

Casi todo eso ya estaba en los datos:

| Estado | De dónde sale |
|---|---|
| cerrada | `status = 'closed'` |
| seguimiento | `snoozed_until > now()` ← **lo único que se guarda** |
| nueva | `human_reply_at IS NULL` — nadie ha respondido nunca |
| por responder | el último mensaje es del cliente |
| esperando cliente | el último mensaje es nuestro |

Así que 0020 añade **una sola columna** y el resto se calcula al listar. El costo: un agente no puede declarar «estoy en ello» sin responder. A cambio, ningún estado puede estar desactualizado.

**Que conteste el bot no cuenta como atendida.** `human_reply_at` lo pone la puerta de envío solo cuando escribe una persona ([[salesbots]] §El relevo). Una conversación que solo ha hablado con el bot sigue siendo «nueva», que es justo lo que recepción necesita ver.

La definición vive **en un sitio** —una constante SQL que se usa para devolver el estado y para filtrar por él—. Dos copias, una en el `SELECT` y otra en el `WHERE`, se separarían el día que alguien ajuste una, y el filtro dejaría de coincidir con lo que se ve.

## Filtros y vistas guardadas

El usuario pidió «un menú desplegable como el de Kommo, pero mucho mejor». Lo que se hizo:

- **Búsqueda siempre visible**, sin abrir nada: por nombre del contacto, su @ o su teléfono. **No busca dentro de los mensajes**: `messages` está particionada y sin índice de texto, y un `ILIKE` ahí recorrería meses. Buscar en el contenido es otro PR, con su índice.
- **Panel de filtros** con estado de atención, responsable, **etapa del embudo** y rango de fechas. El botón muestra cuántos hay puestos: un filtro invisible es el que confunde.
- **Vistas guardadas por agente**: un filtro con nombre. Se guardan como JSON con los mismos parámetros que entiende la lista, así que añadir un filtro nuevo no obliga a tocar nada. Son del agente y no de la cuenta: su forma de trabajar, no una configuración del hotel.
- Guardar dos veces con el mismo nombre **actualiza** en vez de fallar, que es lo que espera quien ajusta un filtro y vuelve a pulsar «Guardar».
- Aplicar una vista **reemplaza** los filtros, no se suma a ellos: si se sumara, el resultado no sería el que se guardó.

El panel es **opaco**, no de vidrio: cae encima de la lista de conversaciones, y con transparencia se leen las dos cosas a la vez, que es no leer ninguna.

## Aplazar

Es el único estado que se guarda porque es el único que no está en los datos: nada dice «vuelve a acordarte de esto el jueves». No hace falta ningún trabajo periódico que las despierte — como el estado se calcula al leer, a su hora reaparece sola.

## Notas internas

![[2026-09-11-bandeja-notas.png]]

Tenían tabla desde la fase 0 y no las usaba nadie. Ahora viven en la ficha del contacto, **no en el hilo**, con otro color y un aviso en el título: «solo las ve el equipo». Mezclarlas en el hilo con una marca convierte un descuido visual en un mensaje enviado al cliente, y eso no se deshace.

No son mensajes: no pasan por la puerta de envío, no tocan la ventana de 24 h y no aparecen en `messages` — hay un test que lo comprueba justamente porque el fallo sería silencioso y caro. Cada uno borra las suyas; reescribir lo que dijo un compañero no es una función.

## Lo que falta

- **Tiempo real.** Hoy se sondea cada 10 s. Es la deuda más visible de esta pantalla.
- **Buscar dentro de los mensajes**, con su índice.
- Compartir vistas entre el equipo (hoy son de cada agente).
- Reparto automático y horario comercial: las tablas `teams` y `business_hours` siguen sin usarse.
