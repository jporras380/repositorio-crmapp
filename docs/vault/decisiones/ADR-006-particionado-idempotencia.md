---
estado: aceptado
fecha: 2026-09-07
modulo: db
tags: [adr, particionado, idempotencia, postgres, messages, contradiccion-de-requisitos]
---

# ADR-006 — Particionado de `messages` e idempotencia

## Contexto

Dos requisitos del prompt maestro que **se contradicen entre sí**, y hay que resolver la contradicción en el diseño y no descubrirla en producción:

- **8.7** — `messages` particionada por fecha desde el diseño.
- **8.1** — idempotencia con índice único sobre `(channel_account_id, external_message_id)`, porque Meta reenvía eventos.

El choque: **en PostgreSQL, un índice único sobre una tabla particionada debe incluir las columnas de partición.** Un `UNIQUE (channel_account_id, external_message_id)` a secas no se puede crear. Y si se añade `created_at` para que sea creable, la unicidad queda confinada a cada partición mensual — con lo que un reenvío de Meta a caballo de fin de mes se duplicaría. Justo el caso que la idempotencia debía cubrir.

## Decisión

**Particionar `messages` por rango de `created_at`, mensual, con PK `(created_at, id)`**, y llevar la idempotencia a una tabla aparte:

**`message_keys`, no particionada**, con `UNIQUE (channel_account_id, external_message_id)` apuntando a `message_id` y `created_at`.

El flujo de ingesta intenta primero insertar en `message_keys`. Si choca, es un duplicado y no se escribe mensaje. Todo dentro de la misma transacción que el `INSERT` en `messages`.

Se particionan igualmente `usage_events` y `audit_log` (por mes) e `inbound_events` (por semana, retención corta). Las particiones se precrean con tres meses de antelación desde un job; **una partición que falta no es un error recuperable, es una caída de la ingesta**, así que el job tiene alerta propia.

## Costo de lo elegido

- **Una escritura extra por mensaje entrante**, y una tabla que crece indefinidamente si no se poda. Retención propia de 90 días: más allá de eso, Meta ya no reenvía nada y la fila no protege de nada.
- **Las consultas deben filtrar por fecha para que haya pruning.** Una consulta sin `created_at` recorre todas las particiones. Afecta sobre todo a búsquedas globales dentro de una conversación antigua.
- **Los índices son por partición.** El índice de `conversation_id` existe N veces; el planificador lo maneja bien, pero el tamaño total en disco es mayor de lo que sugiere pensar en una sola tabla.
- **La PK compuesta `(created_at, id)` se filtra a las claves foráneas.** Cualquier tabla que apunte a un mensaje necesita las dos columnas. Es feo y hay que asumirlo.

## Qué gana el particionado, y por qué se mantiene pese al costo

No es el rendimiento de lectura — con el volumen de S-3, una tabla sin particionar iría bien durante bastante tiempo. Es el **borrado**: `DETACH PARTITION` elimina millones de filas en un instante, sin `VACUUM` ni bloat, y el requisito 8.11 pide retención configurable. Ese solo motivo lo justifica.

## La contradicción que queda abierta

**El requisito 8.11 pide retención por inquilino, y `DETACH PARTITION` borra a todos por igual.** Una retención más corta para un cliente concreto obliga a borrado selectivo por lotes, con su coste de vacuum — es decir, a renunciar a la ventaja principal del particionado para ese caso.

Queda como **P-07**, sin resolver. Es honesto decir que este ADR resuelve una de las dos contradicciones y deja la otra en manos del usuario, porque la respuesta depende de qué se le prometa al cliente, no de la base de datos.

## Alternativas descartadas

### `UNIQUE (channel_account_id, external_message_id, created_at)` y aceptar la unicidad por partición
Descartada: es la trampa. Parece que funciona, pasa todos los tests, y falla el primer día 1 de mes con un reenvío tardío. Un fallo estacional que solo aparece en producción es peor que no tener el índice.

### No particionar
*Habría ganado* si la retención fuera indefinida y uniforme. Con retención configurable, el borrado masivo por `DELETE` genera bloat y `VACUUM` largos sobre la tabla más caliente del sistema, justo cuando hay tráfico.

### Deduplicar solo en `inbound_events`
Descartada porque `inbound_events` tiene retención corta a propósito: un reenvío posterior a su ventana de retención pasaría el filtro. Además mezcla dos responsabilidades —trazabilidad del webhook y unicidad del mensaje— en una tabla que se poda.

### Deduplicar en Redis
Descartada: la idempotencia es una garantía transaccional. Si vive fuera de la transacción, un fallo entre el `SET` de Redis y el `COMMIT` de PostgreSQL rompe exactamente lo que se quería garantizar.

## Cómo se revierte

Quitar `message_keys` es trivial. Quitar el particionado de una `messages` con millones de filas **no lo es**: exige reescribir la tabla. **Es la decisión menos reversible de todo el ARCH**, y el motivo por el que hay que tomarla antes de la primera fila y no después.

## Señal de revisión

Si P-07 se resuelve como "retención por inquilino con borrado selectivo", el particionado pierde su justificación principal y conviene reevaluar si compensa el costo — aunque para entonces ya será tarde para quitarlo barato. Otra razón para resolver P-07 pronto.
