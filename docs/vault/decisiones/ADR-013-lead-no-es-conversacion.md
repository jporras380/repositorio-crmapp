---
estado: aceptado
fecha: 2026-09-11
modulo: embudo
tags: [adr, embudo, leads, conversaciones, hotel, kommo]
---

# ADR-013 — Un lead no es una conversación

## Contexto

El usuario pidió el embudo en kanban después de enseñar el suyo de Kommo, y en la misma sesión el proyecto pasó a tener cliente y dominio concretos: **Apart Hotel El Paraíso de Barranca**. El encargo nuevo (§7 y §10) trae una lista de estados que mezcla dos cosas —*Nuevo, En atención, Esperando cliente* junto a *Reservado, Confirmado, Perdido*— y pide que una conversación pueda convertirse en reserva.

Había que decidir qué entidad lleva el estado de la venta.

## Opciones

| | Qué era |
|---|---|
| **A. El lead es la conversación** | Una columna `stage_id` en `conversations`. Cero tablas nuevas. |
| **B. Lead como entidad propia** | Tabla `leads` colgando del **contacto**, con la conversación que lo originó guardada al lado. |
| **C. Ocho estados en la conversación** | La lista del encargo tal cual, en `conversations.status`. |

## Decisión

**B.** Y el reparto queda así: **la atención vive en la conversación; la venta, en el embudo.**

## Por qué

El caso que decide no es de diseño, es del negocio del cliente: **en un hotel volver es lo que se busca**. La misma familia reserva en Fiestas Patrias y otra vez en enero, y escribe por el mismo WhatsApp.

Con A o C, esa segunda reserva tiene dos salidas y las dos son malas: o pisa el estado de la primera —y el historial deja de valer— o hay que abrir un hilo duplicado en la bandeja para no perderlo, que es justo lo que la bandeja única existe para evitar. Además el pronóstico contaría una vez lo que son dos ventas.

Con B, un contacto acumula tantos leads como veces vuelva, y **como mucho uno abierto a la vez** por embudo (lo impone un índice único parcial, no una comprobación de la aplicación).

Lo que decide si una etapa cuenta en el pronóstico es su **tipo** (`abierta`/`ganada`/`perdida`), no su nombre. El cliente renombra columnas cuando quiere; una suma que dependiera de que una columna se llame «Confirmada» se rompería el primer día.

## Costo de lo elegido

- **Dos conceptos que explicar** a quien atiende: el estado de la conversación y la etapa del lead. En C habría uno solo.
- La ingesta gana una responsabilidad: decidir, en cada entrante, si abre lead nuevo o entra en el abierto. La regla vive en `apps/worker/src/leads.ts` y tiene test.
- El orden dentro de una columna **no se guarda**: manda la fecha. Se pierde la prioridad manual que Kommo sí permite; se gana no mantener una columna de posición con sus empates y sus reindexados.
- Sin motor de disponibilidad (decisión del usuario para la primera entrega), el embudo **no impide la sobreventa**: dos agentes pueden llevar dos bungalows iguales a «Confirmada» el mismo fin de semana. Lo ve una persona, no el sistema.

## Qué haría cambiar esta decisión

- Si apareciera un negocio donde el cliente **nunca** vuelve, A sería más barata y igual de correcta.
- Si el hotel pide reservar varias habitaciones distintas en la misma consulta, el lead se queda corto y lo natural es que la **reserva** (PR-37) sea la entidad con líneas, no el lead.

## Cómo se revierte

La migración `0018_embudo` es aditiva: cinco tablas y una función. Nada anterior depende de ellas, así que la reversa las tira y el resto del producto sigue igual. Lo que se pierde son los leads, que es exactamente lo que esa migración creó.
