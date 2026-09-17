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

## La única respuesta privada ya no se puede gastar dos veces (PR-64, 2026-09-17)

`respuestasPrivadasPorComentario` está en el contrato de canales desde PR-7, los tres adaptadores la declaran, dos tests la comprueban… y **el producto no la usaba**. Su propio comentario decía lo que había que hacer: «es un dato que el producto tiene que mostrar ANTES de enviar: si el agente gasta la única respuesta privada en un saludo, no hay segunda oportunidad».

Instagram y Facebook permiten **una** respuesta privada por comentario, y no se recupera. Un «ahora te cuento» y se acabó la vía privada con ese cliente.

Sale de un repaso deliberado, no de un tropiezo: en un solo día aparecieron cuatro fallos del mismo tipo —`limitesDeMedios` (PR-54), `requiereUrlPublicaParaMedios` (PR-57), `last_event_at` (PR-62) y este—, así que se buscaron los demás a propósito.

### Cómo queda

- **La puerta de envío lo impide**, no lo avisa: la segunda privada muere con un 409 `respuesta_privada_agotada` que dice qué queda por hacer. Antes salía hacia Meta y fallaba allí con un error genérico.
- **Se cuenta lo que SALIÓ, no lo que se intentó.** Un envío fallido no gasta cupo en el proveedor, y contarlo dejaría al agente sin su única vía por un corte de red.
- **El compositor lo dice antes de pulsar** —«la respuesta privada es una sola por comentario, y no se recupera»— y desactiva el botón cuando ya se usó, dejando la pública, que es lo que le queda.
- **Quién decide sigue siendo el servidor.** La web no cuenta nada: cada mensaje trae ahora `modo_comentario`, y la web lo pinta.

### Lo que salió al escribir los tests

Dos cosas que ya estaban y nadie había visto:

1. Una respuesta a comentario se guarda con `type = 'text'` —es lo que sale por el canal— y lo que la distingue es su `payload.comentario`. La primera versión de la consulta filtraba por `type = 'comment_reply'` y no habría contado nada.
2. El fixture de tests usaba **el mismo id de comentario** (`c.777`) en todos los hilos, así que la cuenta se mezclaba entre conversaciones. Ahora cada hilo tiene el suyo, como en Meta, y la consulta acota también por conversación.

### Cómo comprobarlo en menos de 5 minutos

Abrir un hilo de comentarios, responder en privado, y mirar el compositor: el botón «En privado» queda desactivado y el texto explica por qué. «En público» sigue disponible.

## Aplazar una conversación (PR-65, 2026-09-17)

Otra pieza completa sin puerta de entrada, encontrada en el mismo barrido que PR-64: el endpoint `PATCH /v1/conversaciones/:id/aplazar` existía, `snoozed_until` se guardaba, el estado de atención tenía su valor «seguimiento» y la lista sabía pintar la insignia **«Aplazada»**… y **no había ningún botón que lo llamara**. Se podía ver una conversación aplazada y no se podía aplazar ninguna. Incluso el método estaba en el cliente web, sin que ningún componente lo usara.

Ahora hay un botón en la cabecera del hilo con tres plazos y el deshacer.

### Decisiones

- **Plazos fijos, no un calendario.** Quien atiende una recepción no quiere elegir día y hora: quiere quitarse algo de encima ahora y que vuelva luego. Tres opciones cubren el día de trabajo. Precio: para «el lunes que viene» hay que aplazar dos veces.
- **«Mañana a las 9:00» usa la hora de quien mira**, no UTC ni la del hotel. El agente piensa en su reloj, y el que abre el CRM es quien va a volver a ver la conversación.
- **Deshacer está donde se hizo.** Buscar el «quitar» en otro sitio es lo que hace que estas funciones dejen de usarse.
- **Un aplazamiento vencido no cuenta como aplazada.** El botón vuelve a decir «Aplazar» solo, sin que nadie tenga que limpiarlo.

### Cómo comprobarlo en menos de 5 minutos

Abrir una conversación → «Aplazar» → «En 1 hora». El botón pasa a «Aplazada» y la fila de la lista muestra la insignia. Volver a pulsarlo y elegir «Volver a verla ahora» lo deshace.
