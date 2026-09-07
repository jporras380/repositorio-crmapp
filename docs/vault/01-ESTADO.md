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
- **`docs/ARCH.md` completo**: alcance, supuestos, principios, componentes, modelo de datos, RLS, ingesta, contrato de adaptador, colas, secretos, multimedia, observabilidad, privacidad, fases y riesgos.
- **Los siete ADR escritos y en estado `aceptado`.** ADR-001/002/003 cerrados; ADR-005 (RLS), ADR-006 (particionado e idempotencia) y ADR-007 (identidad de contactos) nuevos.

## A medias

Nada. Este PR entrega documentación cerrada.

## Resuelto hoy, en segunda sesión de trabajo

**P-01 decidida: BYO-credentials.** El cliente trae su propia WABA y paga a Meta directamente. Ver [[ADR-004-modelo-whatsapp]]. Evaluado con matriz ponderada y con Kommo como referencia empírica: puntuó 99 sobre 115, frente a 90 de Tech Provider con Embedded Signup, 53 de BSP con prepago y 39 de WABA compartida.

**P-02 disuelta como consecuencia.** Si el cliente paga a Meta directo, no hay costo que repercutir ni que absorber. Sale de la lista de parada y **se elimina el módulo de wallet del roadmap**. Lo que queda es P-21: qué medimos y cobramos nosotros.

## ARCH escrito bajo supuestos

El usuario ordenó proceder sin respuesta a P-04, P-05 y P-06. El ARCH se escribió bajo tres supuestos explícitos, **cada uno con el umbral en el que deja de valer** — esa es la parte que hay que releer, no el supuesto:

- **S-1 (P-04)** una sola región, con GDPR como línea base por ser el marco más estricto. Deja de valer si un cliente exige residencia en otra jurisdicción; sería cambio de topología, no de esquema.
- **S-2 (P-05)** producto especulativo, primer cliente piloto acompañado. Deja de valer en cuanto haya cliente firmado con fecha.
- **S-3 (P-06)** menos de 100 inquilinos y 5 M mensajes/mes. **Es el supuesto que más decide el documento**: justifica no tener réplica de lectura, usar vistas materializadas y particionar por mes. Deja de valer sobre 20 M mensajes/mes o pico de 200 msg/s.

Las tres preguntas siguen abiertas en [[02-PREGUNTAS-ABIERTAS]]. Responderlas ahora es barato; después de fase 1, no.

## Bloqueado

Nada bloquea el avance. **Lo que falta es tu aprobación del ARCH** para poder empezar fase 0.

## Qué sigue

1. **Aprobar `docs/ARCH.md`.**
2. PR-1: andamiaje del monorepo — instalar `pnpm` (no está en la máquina; Node v24.16.0), workspaces, Turborepo, CI, `docker-compose` de desarrollo. Sin lógica de negocio.
3. Fase 0: esquema base, auth, multi-tenancy con RLS, outbox, adaptador en sandbox. Criterio de salida: crear cuenta e invitar usuario **y que los dos tests de RLS de §6 del ARCH pasen en CI**.
4. Responder P-04, P-05 y P-06 en algún momento antes de fase 1.

## Cambio propuesto al plan de fases

Adelantar la **medición** de uso (`usage_events` y contadores) de fase 4 a fase 1, aunque cobrar siga en fase 4. Un evento de uso se emite en el mismo punto donde se envía el mensaje; añadirlo después obliga a volver a tocar todas las rutas de envío y deja el periodo anterior sin datos que reconstruir. Emitir desde el principio cuesta poco, retroactivar es imposible.

## Riesgo principal vigente

La dependencia de aprobaciones de Meta. **[[ADR-004-modelo-whatsapp]] lo reduce pero no lo elimina:** BYO-credentials evita el App Review del flujo de Embedded Signup y permite desarrollar y pilotar ya, con el cliente añadido como tester de nuestra app. Pero servir a clientes sin rol en esa app sigue exigiendo **Acceso Avanzado** a `whatsapp_business_messaging`, que pasa por revisión de Meta. La mitigación de fase 0 no cambia: adaptador con modo sandbox, para que ninguna fase dependa de credenciales reales.
