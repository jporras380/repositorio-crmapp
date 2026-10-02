---
estado: aceptado
fecha: 2026-10-02
modulo: salesbots
tags: [adr, canales, contrato, whatsapp, bots, interactivos]
---

# ADR-014 — Mensajes con opciones en el contrato de canal

## Contexto

`ChannelAdapter` está en la lista de parada desde el primer canal: si se toca con un solo canal delante, se contamina de Meta. Recibir botones y listas ya funcionaba (la ingesta los convierte en texto). **Enviarlos** desde los bots exigía tocar el contrato, y el dueño lo autorizó el 2026-10-02.

Había que decidir cómo entra, para que el segundo canal con botones (Instagram y Messenger tienen respuestas rápidas) no obligue a tocarlo otra vez.

## Opciones

| | Qué era |
|---|---|
| **A. `sendText` con un campo opcional `opciones`** | Sin método nuevo. Pero cada adaptador tendría que saber qué hacer con opciones que no soporta, y el núcleo no podría preguntar. |
| **B. Capacidad `interactivos` + método `sendInteractive`** | El núcleo pregunta si el canal tiene opciones y con qué límites; si no, las escribe. |
| **C. Mandar siempre texto con opciones escritas** | Sin tocar el contrato. Pero en WhatsApp el huésped tendría que escribir en vez de pulsar, que es lo que se pidió. |

## Decisión

**B**, siguiendo la regla que gobierna el contrato: **el núcleo pregunta capacidades, no asume**.

- `CapacidadesDeCanal.interactivos: LimitesDeInteractivos | null`. WhatsApp: 3 botones de 20, listas de 10 filas de 24, botón de lista de 20, cuerpo de 1024. Instagram y Facebook: `null`.
- `sendInteractive(EnvioInteractivo)`: obligatorio en todos; los que no los tienen lanzan `tipo_no_soportado`.
- `validarInteractivo` e `interactivoComoTexto` son funciones del contrato, no de cada adaptador.

**Degradar, no fallar.** Si el canal no tiene opciones, o no caben, la puerta de envío las convierte en texto **antes de guardar el mensaje**, así que la bandeja enseña lo que de verdad le llegó al huésped. Un bot que se queda mudo a mitad de conversación es peor que unos botones que llegan escritos.

**Viñetas, no números.** El texto alternativo lista las opciones con «•». El bot reconoce la respuesta por lo que contiene (`condicion`), y alguien que contesta «2» no contiene «Bungalow».

**El diseñador elige opciones, no formato.** Hasta 3 salen como botones; de 4 a 10, como lista. `core` valida al publicar con los límites de WhatsApp (el más estricto de los canales que tienen botones).

## Consecuencias

- Un tipo de mensaje nuevo, `interactive` (migración 0053, reversible: la bajada los convierte en `text`).
- Lo pulsado vuelve como texto con el título: los bots no saben de botones, solo de respuestas. Por eso dos opciones iguales no se publican.
- **Pendiente sin fecha:** las respuestas rápidas de Instagram y Messenger. Entran declarando su capacidad y escribiendo su `sendInteractive`, sin tocar el contrato.
- **Fuera de este ADR:** botones desde el compositor del agente. Se pidió para los bots.

## Lo que lo habría roto en silencio

El esquema zod de la API de flujos no declaraba `opciones` y **zod quita las claves que no conoce**: el bot se habría guardado sin botones, en verde. Hay un test e2e que guarda y relee las opciones, y se vio fallar quitando la línea del esquema.
