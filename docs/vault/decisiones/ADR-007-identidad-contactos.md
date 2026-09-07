---
estado: aceptado
fecha: 2026-09-07
modulo: bandeja
tags: [adr, contactos, identidad, omnicanal, fusion]
---

# ADR-007 — Identidad unificada de contactos

## Contexto

Requisito 6.1: un cliente que escribe por WhatsApp y por Instagram es **una sola persona con hilos separados**. La vista unificada por contacto es una de las razones de existir del producto.

El problema no es mostrarlo, es modelarlo. La tentación es una tabla `contacts` con `channel` y `external_user_id`, y resolver la unificación en la consulta. Funciona hasta el día en que descubres que dos filas son la misma persona.

## Decisión

**Dos tablas, separadas desde el esquema inicial.**

- **`contact_identities`** — el hecho del proveedor: `(tenant_id, contact_id, channel, channel_account_id, external_user_id, handle, profile jsonb)`, con `UNIQUE (channel_account_id, external_user_id)`.
- **`contacts`** — la persona: nuestra interpretación, sin ningún identificador de canal.
- **`contact_merges`** — el registro de cada fusión: origen, destino, quién y por qué.

`conversations` cuelga de `contact_identity_id` —el hilo pertenece al canal— y además guarda `contact_id` **desnormalizado**.

**La fusión nunca es automática por nombre.** Criterio concreto pendiente de P-08.

## El argumento

La identidad que llega del canal es un **hecho inmutable del proveedor**; la persona es una **interpretación nuestra**, y las interpretaciones cambian. Si se mezclan en una tabla, unificar dos filas obliga a reescribir claves foráneas de conversaciones y mensajes — sobre la tabla particionada, con millones de filas, y sin forma limpia de deshacerlo.

Con la separación, fusionar es **repuntar `contact_identities.contact_id`** y escribir una fila en `contact_merges`. Barato, auditable y reversible.

Que Instagram entregue un identificador *scoped* a nuestra app —no el `@handle` público, y no cruzable con nada externo— es la confirmación empírica de que la identidad del canal no puede ser la clave de la persona.

## Costo de lo elegido

- **El `contact_id` desnormalizado en `conversations` hay que mantenerlo en cada fusión.** Es un `UPDATE` acotado, pero es un invariante que se puede romper: si se rompe, la bandeja muestra la conversación colgando de una persona que ya no existe. Necesita test.
- **Una tabla más y un join más** en el alta de conversación, que es un camino caliente.
- **La fusión es una operación de producto**, con interfaz, permisos y auditoría propias. No es un `UPDATE` administrativo: hay que construirla.

## Alternativas descartadas

### Una sola tabla `contacts` con `channel` y `external_user_id`
Más simple y más rápida al principio. *Habría ganado* en un CRM de un solo canal. Descartada porque la unificación es un requisito del MVP, no una idea futura, y el costo de separar después crece con cada mensaje escrito. Es exactamente el tipo de decisión que hay que tomar antes de la primera fila.

### Resolver el `contact_id` por join en cada carga de bandeja, sin desnormalizar
Más limpia: elimina el invariante que hay que mantener. Descartada porque encarece la consulta más caliente del producto —la lista de la bandeja— para ahorrar trabajo en una operación rara. Se cambió pureza por latencia, a conciencia.

### Fusión automática por heurística (nombre, foto, similitud)
Descartada de entrada. Un falso positivo mezcla las conversaciones de dos personas distintas y expone datos personales de una a la otra. En un producto que maneja datos de terceros, el modo de fallo es una brecha, no una molestia. El teléfono E.164 verificado es la única señal fuerte, y aun así conviene que sea propuesta al agente, no acción automática.

## Cómo se revierte

Fusionar dos `contacts` es reversible gracias a `contact_merges`. **Separar `contact_identities` de una `contacts` monolítica, si se hubiera elegido lo contrario, no lo sería** — y esa asimetría es la razón de este ADR.

## Señal de revisión

P-08 define el criterio de fusión. Si acaba siendo "solo manual", conviene revisar si `contact_merges` necesita tanto detalle. Si acaba habiendo fusión asistida, hará falta una cola de sugerencias que hoy no está modelada.
