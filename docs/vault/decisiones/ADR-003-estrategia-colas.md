---
estado: aceptado
fecha: 2026-09-07
modulo: infra
tags: [adr, colas, bullmq, redis, multi-tenant, aislamiento]
---

# ADR-003 — Colas: por función, con semáforo por inquilino

## Contexto

Requisito 8.8: un inquilino con picos no puede bloquear a los demás. El caso real es una campaña masiva de un cliente que llena la cola y deja a otro cliente sin responder mensajes entrantes durante veinte minutos.

BullMQ *open source* **no** tiene reparto justo entre grupos. Esa es la restricción que manda.

## Decisión

**Pocas colas, una por clase de trabajo** (`inbound-ingest`, `outbound-whatsapp`, `outbound-instagram`, `media`, `flows`, `ai`, `outbox-relay`), **no una por inquilino**.

El aislamiento lo da un **semáforo de concurrencia por inquilino en Redis**: antes de procesar, el worker intenta tomar un permiso de `tenant:<id>:<cola>`. Si el inquilino ya tiene N jobs en vuelo, el job se reencola con un retraso corto en lugar de ocupar el worker. Los permisos llevan **TTL** para que un worker muerto no bloquee al cliente indefinidamente.

**Escotilla de escape:** mover un inquilino concreto a cola dedicada debe ser un cambio de configuración, no de arquitectura. El nombre de la cola se resuelve por una función que consulta una lista de excepciones.

## Costo de lo elegido

- Un job de un inquilino saturado puede **rebotar varias veces** antes de ejecutarse. Genera ruido en las métricas (el conteo de intentos deja de significar "fallos") y latencia extra — para ese inquilino, no para los demás, que es el objetivo. Hay que separar la métrica de "reintento por saturación" de la de "reintento por error", o las alertas mienten.
- El semáforo es código nuestro y es el punto donde un bug causa un bloqueo silencioso. Necesita test de liberación por TTL, no solo de camino feliz.
- La equidad es aproximada, no garantizada: con la cola llena de un solo inquilino, los demás avanzan pero no con prioridad.

## Alternativas descartadas

### Una cola por inquilino
Aislamiento perfecto y trivial de razonar. Descartada por el costo en Redis y en operación: cada cola de BullMQ implica un worker con su propia conexión bloqueante. Con cientos de inquilinos son cientos de conexiones bloqueantes, más un supervisor que cree y destruya workers al alta y baja de cada cliente. El costo crece **lineal con las ventas**, que es la peor forma de que crezca un costo de infraestructura.
*Habría ganado* con pocas decenas de inquilinos grandes en lugar de muchos pequeños. Depende de [[02-PREGUNTAS-ABIERTAS]] P-06.

### BullMQ Pro
Resuelve el reparto justo por grupos de forma nativa, que es exactamente este problema. Es licencia de pago → **lista de parada**, ligada a P-14 (presupuesto de infraestructura). Si el presupuesto lo admite, es probablemente la respuesta correcta y este ADR se sustituye.

### Prioridad ponderada en cola compartida
Descartada porque la prioridad de BullMQ no acota la concurrencia: un inquilino con 10.000 jobs de la misma prioridad los procesa todos igual. La prioridad ordena, no reparte.

## Cómo se revierte

Barato. El semáforo es un envoltorio sobre el procesador del worker; quitarlo o sustituirlo por grupos de BullMQ Pro no toca la definición de los jobs. Es la decisión más reversible de las tres.

## Señal de revisión

Primer plan enterprise con SLA de latencia contractual, o primera vez que un cliente se queje de latencia y la causa sea el rebote del semáforo.
