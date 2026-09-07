---
estado: vivo
fecha: 2026-09-07
modulo: meta
tags: [indice, vault]
---

# CRM omnicanal — Índice del vault

Memoria de largo plazo del proyecto. **El código es la verdad sobre el qué; este vault es la verdad sobre el porqué.**

Si algo se averigua leyendo el código en menos de un minuto, no va aquí. No hay firmas de funciones, esquemas de tablas ni listas de endpoints en estas notas: se desactualizan al primer refactor y a partir de ahí la memoria miente.

## Empieza por aquí

- [[01-ESTADO]] — dónde estamos hoy. Se reescribe cada sesión.
- [[02-PREGUNTAS-ABIERTAS]] — lo que necesita decisión del usuario, por urgencia.

## Decisiones

| ADR | Tema | Estado |
|---|---|---|
| [[ADR-000-plantilla]] | Formato de los ADR | vivo |
| [[ADR-001-orm]] | ORM: Drizzle sobre Prisma | borrador |
| [[ADR-002-motor-salesbots]] | Máquina de estados propia sobre Temporal | borrador |
| [[ADR-003-estrategia-colas]] | Colas por función + semáforo por inquilino | borrador |
| [[ADR-004-modelo-whatsapp]] | Conexión a WhatsApp: BYO-credentials | **aceptado** |

Pendientes de escribir: RLS (ADR-005), particionado e idempotencia (ADR-006), identidad unificada de contactos (ADR-007).

## Canales

Lo más valioso del vault. Aquí van las restricciones externas que costaron tiempo descubrir y que no están en ninguna documentación.

- [[whatsapp]] — canal del MVP.
- [[instagram]] — fase 2.
- [[tiktok]] — fase 7, acceso restringido.

## Módulos

Una nota por módulo, con las decisiones que le afectan enlazadas. Se crean al empezar cada módulo, no antes.

Previstos: bandeja, plantillas, salesbots, ia, usuarios, facturacion, panel, integraciones.

## Aprendizajes

Lo que salió mal y por qué. Una nota por incidente. Vacío por ahora, y eso es buena señal.

## Sesiones

Bitácora diaria.

- [[2026-09-07]] — arranque: inventario de skills, vault, esquema propuesto, tres ADR.

## Reglas de este vault

1. Nota que pasa de dos pantallas, se parte.
2. Frontmatter YAML siempre: `estado`, `fecha`, `modulo`, `tags`.
3. Cuando una nota deja de ser cierta, se corrige o se marca `estado: obsoleto` con un enlace a la que la sustituye. Dos respuestas distintas a la misma pregunta es ruido, no memoria.
4. Enlaces con `[[wikilinks]]`. Un enlace a una nota que no existe todavía marca trabajo pendiente, no es un error.
