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

## Bloqueado

**El ARCH completo está bloqueado** esperando respuesta a las preguntas P-01 a P-06 de [[02-PREGUNTAS-ABIERTAS]]. Las tres que más duelen:

- **P-01** modelo de WhatsApp (Tech Provider propio / BSP / WABA compartida) — marcada "aún no decidido" por el usuario. Decide `channel_accounts`, el onboarding y quién paga a Meta.
- **P-02** repercutir o absorber el costo de mensajería — está en la lista de parada de la sección 9.
- **P-04** región de datos y marco legal — cambiarlo después es una migración de datos personales.

## Qué sigue

1. El usuario responde P-01 a P-06.
2. Escribir el ARCH completo, cerrando los ADR-001/002/003 y añadiendo ADR-004 (RLS), ADR-005 (particionado e idempotencia) y ADR-006 (identidad de contactos).
3. PR-1: andamiaje del monorepo — `pnpm` (no instalado en la máquina; Node v24.16.0), workspaces, Turborepo, CI, `docker-compose` de desarrollo. Sin lógica de negocio.
4. Fase 0 propiamente: esquema base, auth, multi-tenancy con RLS, outbox. Criterio de salida: crear cuenta e invitar usuario.

## Cambio propuesto al plan de fases

Adelantar la **medición** de uso (`usage_events` y contadores) de fase 4 a fase 1, aunque cobrar siga en fase 4. Un evento de uso se emite en el mismo punto donde se envía el mensaje; añadirlo después obliga a volver a tocar todas las rutas de envío y deja el periodo anterior sin datos que reconstruir. Emitir desde el principio cuesta poco, retroactivar es imposible.

## Riesgo principal vigente

La dependencia de aprobaciones de Meta. Detalle en [[whatsapp]]. La mitigación es de fase 0, no posterior: adaptador con modo sandbox para que ninguna fase dependa de credenciales reales.
