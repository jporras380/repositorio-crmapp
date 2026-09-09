---
estado: vivo
fecha: 2026-09-09
modulo: meta
tags: [estado, sesion]
---

# Estado — 9 de septiembre de 2026

Fase actual: **fase 1 en curso**. Fase 0 **completada**, con su criterio de salida cumplido y con evidencia ejecutable: `apps/api/test/fase0.e2e.test.ts`. Repositorio en `github.com/jporras380/repositorio-crmapp`.

## Completado

- Repositorio inicializado (`git init`, rama `main`). No es monorepo todavía: no hay `package.json`.
- Vault creado con contenido real: índice, este estado, preguntas abiertas, tres ADR en borrador y tres notas de canal.
- `.gitignore` y `.env.example` (solo nombres, cero valores).
- Inventario de skills hecho. Instalados `claude-security`, `frontend-design` y `feature-dev`. Ver [[2026-09-07]].
- **PR-11, visibilidad entre agentes**: P-09 resuelto con `decision-eval` ([[ADR-008-visibilidad-entre-agentes]]). Política por cuenta, aplicada en lista, lectura y envío con la misma regla. 11 tests.
- **`main` fusionado hasta PR-10** por *fast-forward*, tras evaluar fusionar ahora frente a seguir apilando. **La CI corre por primera vez**: hay que mirar *Actions*.
- **PR-10, bandeja y envío**: listado con filtros (canal, estado, agente, etiqueta con color, sin respuesta) y paginación por cursor; envío por la puerta completa del ARCH §9 con errores tipados; asignación, estado y etiquetas; consumidor de salida en el worker con reserva condicional y `reintentable`. 26 tests.
- **PR-9, `apps/worker`**: procesamiento de webhooks en una transacción por inquilino — idempotencia contra `message_keys` (con test de carrera), identidad y persona separadas, reapertura de conversación, ventana recalculada con la política del adaptador, estados de entrega que nunca retroceden, y omisión por suspensión. Bootstrap con relay → BullMQ y semáforo por inquilino. 17 tests contra PostgreSQL real.
- **PR-8, ingesta de webhooks**: firma HMAC sobre bytes crudos, persistencia del crudo incluso con firma inválida, evento al outbox y 200 en menos de un segundo. Migración 0009 y `BaseDeDatos.sinInquilino()`. 18 tests e2e.
- **PR-7, `packages/channels`**: contrato `ChannelAdapter` con capacidades declaradas, errores tipados con `reintentable`, registro y adaptador sandbox. Más la primitiva de ventana de sesión en `core`. **El contrato entra en la lista de parada a partir de aquí.** 20 tests.
- **PR-6, `apps/api`**: alta de cuenta, inicio de sesión, invitaciones y auditoría sobre NestJS. **Cierra fase 0**: 16 tests e2e por HTTP real contra PostgreSQL real, con la API corriendo como rol de aplicación sujeto a RLS. Más el rol `crmapp_auth` de solo lectura (migración 0008) y hash de contraseñas con scrypt.
- **PR-5, `packages/core`**: ciclo de vida de la suscripción — prueba de un mes, siete días de gracia con solo texto, suspensión con desconexión de canales. 49 tests, todos sin base de datos ni reloj real. Más migración 0007 con `plans` y `subscriptions`. Ver [[facturacion]].
- **PR-4, `packages/queue`**: relay del outbox con `FOR UPDATE SKIP LOCKED`, semáforo de concurrencia por inquilino en Lua, y definición tipada de colas. 23 tests contra PostgreSQL y Redis reales. Ver [[2026-09-09]].
- **PR-3, cimientos**: `packages/config` (validación con Zod que falla al arrancar), `packages/crypto` (envelope encryption con rotación barata, y redacción de logs en dos capas) y `packages/observability` (logger estructurado). **El test que el ARCH §11 pide por su nombre ya existe y pasa.** Ver [[2026-09-09]].
- **PR-2, `packages/db`**: cinco migraciones SQL con su reversa, esquema Drizzle, cliente con `withTenant`, y 18 tests contra PostgreSQL real. **Los dos tests de RLS del ARCH §6 pasan**, más reversibilidad de migraciones, idempotencia e integridad del esquema. Ver [[2026-09-09]].
- **PR-1, andamiaje del monorepo**: pnpm workspaces, Turborepo, TypeScript estricto, Prettier, CI de GitHub Actions, `docker-compose` de desarrollo (PostgreSQL 18, Redis 7, MinIO, Mailpit) y **guardas de arquitectura ejecutables**.
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

Nada.

## Qué sigue

**Fase 1**: adaptador de WhatsApp, webhooks, bandeja, multimedia y los dos tipos de plantilla. Criterio de salida: un agente atiende WhatsApp de punta a punta.

1. **Comprobar la CI en GitHub Actions** tras la fusión de `main`. Si falla, arreglarla antes que nada.
2. **PR-12**: resolver **P-24** (vocabulario de tipos a inglés en el contrato) y escribir el adaptador real de WhatsApp Cloud API. A partir de ahí el contrato entra en la lista de parada.
3. PR-13: multimedia — descarga de medios entrantes antes de que caduque la URL, subida a S3/MinIO, miniaturas.
4. PR-14: plantillas (respuestas rápidas y HSM con sincronización de estado), que además llena `plantillasSugeridas` del 409 de fuera de ventana.
5. Pendiente de responder: P-04, P-05, P-06 y P-22 — con la señal de Kommo, P-04 y P-05 casi se responden solas.

## Cambio propuesto al plan de fases

Adelantar la **medición** de uso (`usage_events` y contadores) de fase 4 a fase 1, aunque cobrar siga en fase 4. Un evento de uso se emite en el mismo punto donde se envía el mensaje; añadirlo después obliga a volver a tocar todas las rutas de envío y deja el periodo anterior sin datos que reconstruir. Emitir desde el principio cuesta poco, retroactivar es imposible.

## Riesgo principal vigente

La dependencia de aprobaciones de Meta. **[[ADR-004-modelo-whatsapp]] lo reduce pero no lo elimina:** BYO-credentials evita el App Review del flujo de Embedded Signup y permite desarrollar y pilotar ya, con el cliente añadido como tester de nuestra app. Pero servir a clientes sin rol en esa app sigue exigiendo **Acceso Avanzado** a `whatsapp_business_messaging`, que pasa por revisión de Meta. La mitigación de fase 0 no cambia: adaptador con modo sandbox, para que ninguna fase dependa de credenciales reales.
