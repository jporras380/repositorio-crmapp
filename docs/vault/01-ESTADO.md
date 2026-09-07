---
estado: vivo
fecha: 2026-09-07
modulo: meta
tags: [estado, sesion]
---

# Estado — 7 de septiembre de 2026

Fase actual: **pre-fase 0**. No hay código de producto y no lo habrá hasta aprobar el ARCH (regla 10 del prompt maestro).

## Completado

- Repositorio inicializado (`git init`, rama `main`). No es monorepo todavía: no hay `package.json`.
- Vault creado con contenido real: índice, este estado, preguntas abiertas, tres ADR en borrador y tres notas de canal.
- `.gitignore` y `.env.example` (solo nombres, cero valores).
- Inventario de skills hecho. Instalados `claude-security`, `frontend-design` y `feature-dev`. Ver [[2026-09-07]].
- Propuestas redactadas y pendientes de aprobación: estructura de monorepo, esquema inicial de PostgreSQL, decisiones de particionado, RLS e identidad unificada de contactos.

## A medias

Nada. Este PR entrega documentación cerrada.

## Resuelto hoy, en segunda sesión de trabajo

**P-01 decidida: BYO-credentials.** El cliente trae su propia WABA y paga a Meta directamente. Ver [[ADR-004-modelo-whatsapp]]. Evaluado con matriz ponderada y con Kommo como referencia empírica: puntuó 99 sobre 115, frente a 90 de Tech Provider con Embedded Signup, 53 de BSP con prepago y 39 de WABA compartida.

**P-02 disuelta como consecuencia.** Si el cliente paga a Meta directo, no hay costo que repercutir ni que absorber. Sale de la lista de parada y **se elimina el módulo de wallet del roadmap**. Lo que queda es P-21: qué medimos y cobramos nosotros.

## Bloqueado

**El ARCH completo sigue bloqueado**, ahora solo por tres preguntas de [[02-PREGUNTAS-ABIERTAS]]:

- **P-04** región de datos y marco legal — cambiarlo después es una migración de datos personales.
- **P-05** ¿cliente concreto esperando, o producto especulativo? Subió de importancia: BYO-credentials filtra clientes que no sepan montar su propio Meta Business Portfolio.
- **P-06** volumen esperado año 1 — dimensiona particionado, Redis y réplica de lectura.

## Qué sigue

1. El usuario responde P-04, P-05 y P-06.
2. Escribir el ARCH completo, cerrando los ADR-001/002/003 y añadiendo ADR-005 (RLS), ADR-006 (particionado e idempotencia) y ADR-007 (identidad de contactos).
3. PR-1: andamiaje del monorepo — `pnpm` (no instalado en la máquina; Node v24.16.0), workspaces, Turborepo, CI, `docker-compose` de desarrollo. Sin lógica de negocio.
4. Fase 0 propiamente: esquema base, auth, multi-tenancy con RLS, outbox. Criterio de salida: crear cuenta e invitar usuario.

## Cambio propuesto al plan de fases

Adelantar la **medición** de uso (`usage_events` y contadores) de fase 4 a fase 1, aunque cobrar siga en fase 4. Un evento de uso se emite en el mismo punto donde se envía el mensaje; añadirlo después obliga a volver a tocar todas las rutas de envío y deja el periodo anterior sin datos que reconstruir. Emitir desde el principio cuesta poco, retroactivar es imposible.

## Riesgo principal vigente

La dependencia de aprobaciones de Meta. **[[ADR-004-modelo-whatsapp]] lo reduce pero no lo elimina:** BYO-credentials evita el App Review del flujo de Embedded Signup y permite desarrollar y pilotar ya, con el cliente añadido como tester de nuestra app. Pero servir a clientes sin rol en esa app sigue exigiendo **Acceso Avanzado** a `whatsapp_business_messaging`, que pasa por revisión de Meta. La mitigación de fase 0 no cambia: adaptador con modo sandbox, para que ninguna fase dependa de credenciales reales.
