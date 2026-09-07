---
estado: vivo
fecha: 2026-09-07
modulo: meta
tags: [adr, plantilla]
---

# ADR-000 — Plantilla de ADR

Copiar este archivo para cada decisión irreversible o cara de revertir. Numeración correlativa, nunca se reutiliza un número.

## Cuándo se escribe un ADR

Cuando revertir la decisión costaría más que escribir el documento. Elegir un ORM, sí. Elegir el nombre de una carpeta, no.

## Estructura

```markdown
---
estado: borrador | aceptado | sustituido | obsoleto
fecha: AAAA-MM-DD
modulo: <módulo afectado>
tags: [adr, ...]
sustituye_a: ADR-XXX      # opcional
sustituido_por: ADR-XXX   # opcional
---

# ADR-XXX — Título en una línea

## Contexto
Qué problema fuerza la decisión. Qué restricciones existen. Sin esto, en tres
meses nadie entiende por qué la pregunta era difícil.

## Decisión
Qué elegimos. Una frase.

## Costo de lo elegido
Qué perdemos. Si no hay costo, no era una decisión: era lo obvio, y no
merece un ADR.

## Alternativas descartadas
Una por una, con el escenario concreto en el que habrían ganado. Ese
escenario es la señal de revisión: si algún día se cumple, se reabre el ADR.

## Cómo se revierte
Qué haría falta para deshacerlo y cuánto costaría. Determina si es
"irreversible" o solo "molesto".
```

## Regla

Un ADR no se edita cuando cambia de opinión: se marca `sustituido_por` y se escribe uno nuevo. El historial de decisiones equivocadas es la parte útil.
