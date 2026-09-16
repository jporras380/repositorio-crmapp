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

- **Búsqueda siempre visible**, sin abrir nada: por nombre del contacto, su @, su teléfono **y por lo que se dijo dentro de la conversación** (PR-51, abajo).
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

- Compartir vistas entre el equipo (hoy son de cada agente).
- Equipos: `teams` y `team_members` siguen sin usarse. El reparto de PR-46 reparte
  entre todos los que aceptan asignación, no por equipo.

Ya no están aquí: el tiempo real (PR-49, `pg_notify` + SSE), el horario de
atención (PR-47) y el reparto automático (PR-46).

## Cambiar el nombre del contacto (PR-41, 2026-09-15)

Pedido del usuario: renombrar al contacto «para recordar de qué se le atendió» y verlo en la bandeja. Un lápiz junto al nombre en la ficha, que guarda en `contacts.display_name` por el mismo `PATCH /v1/contactos/:id` de Clientes. No hizo falta API nueva.

![[2026-09-15-renombrar-contacto.png]]

- **Es el nombre de la persona, no el perfil de WhatsApp.** La ingesta solo pone `display_name` al crear el contacto; los mensajes siguientes refrescan la identidad (número, @usuario) y **nunca pisan el nombre**. Hay test del worker que lo fija.
- **Vaciarlo quita el nombre propio** (`null`) y la bandeja vuelve a enseñar número o @usuario. Un nombre vacío no tiene sentido.
- Caso real que lo motiva: un contacto cuyo perfil de WhatsApp se llama «.».

## Administrar etiquetas (PR-44, 2026-09-15)

Pedido del usuario desde el principio: etiquetas editables y un apartado donde administrarlas. **Ajustes → Etiquetas**: crear, renombrar en su sitio, cambiar el color y borrar.

![[2026-09-15-etiquetas.png]]

- **Una etiqueta es la misma en conversaciones, clientes y leads**: renombrarla la cambia en todas partes, sin copiar nada.
- **Antes de borrar se dice cuánto se pierde** («12 conversaciones · 3 clientes · 1 lead»). Borrar la quita de todo (FK en CASCADE).
- **No se deja borrar la que usa un bot** en su versión vigente (409 con los nombres de los bots): su paso «etiquetar» quedaría apuntando a nada. Aun así, el worker **solo pone la etiqueta si todavía existe**, porque una ejecución en vuelo de una versión anterior podría apuntar a una ya borrada; sin eso, la FK tumbaría la ejecución entera.
- Editar y borrar exige supervisor o superior; crear sigue abierto a cualquier agente, como en la bandeja.

## Reparto automático (PR-46, 2026-09-15)

Ajustes → Reparto. **Apagado por defecto**: encenderlo cambia quién ve qué cuando la visibilidad es «solo las suyas» ([[ADR-008-visibilidad-entre-agentes]]), y no se cambia el día a un equipo sin que lo decida alguien.

- **Al menos ocupado, no por turnos.** Por turnos se reparten llegadas, no trabajo: quien cierra rápido seguiría recibiendo lo mismo que quien tiene veinte abiertas. Se asigna a quien tiene menos conversaciones abiertas; con empate, al azar.
- **Quien vuelve a escribir sigue con quien lo atendió**, si esa persona sigue activa y en el reparto. Solo se reasigna si ya no está.
- Se aplica en el worker, en la misma transacción del entrante que abre o reabre la conversación, y **el lead abierto va con ella** si nadie lo lleva.
- Por defecto entran todos los miembros activos, también la dueña en un hotel pequeño; se desmarca a quien no deba recibir. Si está encendido y nadie está marcado, la pantalla lo avisa: las conversaciones quedarían sin asignar.
- Migración 0026: `tenants.auto_assignment` y `memberships.accepts_assignments`.

## Horario de atención y aviso fuera de horario (PR-47, 2026-09-16)

![[2026-09-16-horario.png]]

Ajustes → Horario. `business_hours` existía desde la fase 0 sin usarla nadie; ahora tiene dueño y contrato: `{"1": [["09:00","13:00"],["15:00","20:00"]]}`, día ISO y **hora del hotel**.

- **La hora es la del hotel, no la del servidor.** La conversión la hace `core/horario.ts` con `Intl`, sin dependencia de zonas horarias. Una zona que no se entiende devuelve `null` y **no se avisa**: suponer «cerrado» escribiría a deshora a todo el mundo.
- **Un tramo al revés es un error, no «cruza la medianoche».** Para trasnochar se pone un tramo en cada día. Se valida al guardar, con el día en castellano en el mensaje.
- **El aviso es lo ÚNICO que el CRM envía por su cuenta** sin bot ni agente: apagado por defecto, con el texto que escribe el hotel, y **una vez cada seis horas por conversación** (`conversations.out_of_hours_reply_at`). Sin ese límite, diez mensajes de madrugada serían diez avisos.
- Sale por la misma puerta que todo, con `origen: 'bot'`; si la ventana está cerrada o la suscripción no deja, no se fuerza nada y el mensaje del cliente ya quedó guardado.
- Migración 0027.

## Buscar dentro de los mensajes (PR-51, 2026-09-16)

Escribir «bungalow» en la búsqueda ahora encuentra la conversación donde alguien
dijo esa palabra, no solo los contactos que se llamen así. La misma caja busca
las dos cosas: **quién es** (nombre, @ o teléfono) **y qué se dijo**.

### Cómo está hecho

Migración `0028`: una columna generada `messages.search tsvector` con
`to_tsvector('spanish', body)` y un índice GIN `(tenant_id, search)`. La consulta
de la bandeja añade un `EXISTS` sobre `messages` con
`search @@ websearch_to_tsquery('spanish', $q)`.

### Las tres decisiones y su precio

- **Columna generada, no índice sobre la expresión.** Un índice sobre
  `to_tsvector(...)` solo se usa si la consulta repite la expresión letra por
  letra; una diferencia y PostgreSQL lo ignora *en silencio*, que es la peor
  forma de fallar. Precio: la columna ocupa disco.
- **Diccionario `spanish`, no `simple`.** Así «reservas» encuentra «reserva» y
  «reservar», que es como escribe la gente. Precio: un mensaje en inglés se
  encuentra por su palabra exacta, no por su raíz. Para un hotel que atiende en
  español, el cambio vale.
- **`btree_gin` para meter `tenant_id` en el mismo índice.** Sin la extensión
  harían falta dos índices y un cruce. La migración crea la extensión ella misma
  —lección aprendida: si la creé a mano en mi máquina, la migración miente.
- **GIN pesa al escribir.** Cada mensaje entrante paga un poco más. A este
  volumen no se nota; si algún día se notara, la salida es indexar solo los
  últimos N meses con un índice parcial.

### Cómo comprobarlo en menos de 5 minutos

1. Abrir la bandeja y escribir en la búsqueda una palabra que aparezca dentro de
   una conversación (no el nombre del contacto).
2. Aparece la conversación. Abrirla y comprobar que la palabra está en el hilo.
3. Escribir una palabra que nadie haya dicho: la lista queda vacía.

Cubierto por `apps/api/test/bandeja.e2e.test.ts` → «buscar dentro de los
mensajes (0028)»: por palabra dicha, por otra forma de la palabra
(«reservas» → «reserva»), por nombre del contacto, y lo que nadie dijo no
aparece.

## «Pide una persona» (PR-52, 2026-09-16)

Un bot puede rendirse a propósito con el nodo «Pasar a una persona», y entonces la conversación llega a la bandeja **marcada y con el motivo**: insignia roja en la fila (lo primero del pie, antes que cualquier otra insignia), el motivo entero bajo la cabecera del hilo, y la pestaña **«Piden persona»** al lado de «Sin respuesta».

La marca se apaga **al contestar**, no con un botón. El detalle y su precio están en [[salesbots]] §El relevo al revés.

## Quién dijo cada cosa (PR-56, 2026-09-16)

`messages.sent_by_user_id` se guardaba desde PR-10 y **no se enseñaba en ninguna parte**. En un hotel donde atienden varias personas, «¿quién le prometió eso al cliente?» es la pregunta de cada día, y el dato estaba ahí sin usar.

Cada burbuja saliente lleva ahora el nombre de quien la escribió, delante de la hora.

### Las decisiones

- **Solo lo que sale.** De lo que entra ya se sabe quién es: está en la cabecera. Repetirlo en cada burbuja entrante sería ruido.
- **El nombre se dice una vez por tanda.** Seis burbujas seguidas de Marta no llevan «Marta» seis veces.
- **Pero se agrupa por dirección Y por autor.** Antes se agrupaba solo por dirección: si contestaban dos personas seguidas, el nombre de la segunda quedaba escondido y el hilo decía que había hablado una sola. Era un fallo silencioso —el hilo se leía bien, y mentía— y tiene su test.
- **Un bot dice «Bot»**, no un nombre de persona.
- **Quien deja el equipo no borra su historial.** Su mensaje sigue en el hilo; si el nombre ya no se puede resolver, se dice «Un agente» en vez de fingir que no lo escribió nadie. Se une por fuera (`LEFT JOIN`) justamente para eso.

### Cómo comprobarlo en menos de 5 minutos

1. Responder a una conversación desde el CRM: la burbuja lleva tu nombre.
2. Que responda otra persona del equipo justo después: aparecen los dos nombres, no uno.
3. Enviar dos mensajes seguidos tú: el nombre sale una vez.

Cubierto por `Hilo.test.tsx` (5 casos, el hilo no tenía tests hasta ahora) y 4 en `bandeja.e2e.test.ts`.
