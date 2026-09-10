---
estado: vivo
fecha: 2026-09-09
modulo: meta
tags: [estado, sesion]
---

# Estado — 9 de septiembre de 2026

Fase actual: **fase 1 DEMOSTRADA CON TRÁFICO REAL** (2026-09-09: mensaje entrante verificado y saliente `delivered` con el número de prueba de Meta) y **fase 2 empezada** (Instagram DM y comentarios, PR-19) sobre una fase 1 completa con web (PR-17/18). `packages/core` no se tocó para meter el segundo canal: el criterio de salida de fase 2 se cumple en el núcleo; falta la web de comentarios y la prueba real. Falta la prueba con el número de prueba de Meta —la hará el usuario cuando tenga la app creada—; el recorrido entero está cubierto por tests sin red. Fase 0 **completada**, con su criterio de salida cumplido y con evidencia ejecutable: `apps/api/test/fase0.e2e.test.ts`. Repositorio en `github.com/jporras380/repositorio-crmapp`.

## Completado

- **PR-28, el bot se mide** ([[uso]]): `bot.runs` se registra al ARRANCAR la ejecución y en su misma transacción, y aparece en «Uso del plan» contra `bot_runs_mes`. Se cuenta al arrancar y no al terminar porque una ejecución que espera tres días ya consumió lo que consume; contarla al final dejaría el mes en curso sin datos que cobrar. **Qué se cobra y qué pasa al pasarse sigue siendo P-21 (lista de parada).**
- **PR-27, constructor visual de flujos** ([[salesbots]] §El constructor, [[web]]): sección «Bots» con lista y editor por pasos que se ordena solo siguiendo los enlaces, insertar/borrar que mantienen el flujo enganchado, disparadores, avisos en vivo y **prueba pintada como conversación**. La validación llega del servidor junto con la simulación: la web no duplica ni una regla. `GET /v1/usuarios` nuevo para el paso «asignar». 6 tests de web.
- **PR-26, motor de Salesbots — fase 3 CUMPLIDA** ([[salesbots]], [[ADR-002-motor-salesbots]]): migración 0015 (`flows`, `flow_versions`, `flow_triggers`, `flow_runs`, `flow_run_steps`), grafo y transiciones como dominio puro en `core`, motor en el worker sobre la puerta de [[envio]], API para definir/versionar/publicar/pausar/auditar y **modo prueba sin envío real**. El criterio de salida está probado contra PostgreSQL: un flujo califica un lead sin humano y **sobrevive a perder el temporizador** (lo rescata el barrido). 16 tests de core, 8 de worker, 10 de API.
- **PR-25, la puerta de envío sale de la API** (`packages/envio`): suscripción, estado, ventana, capacidades y outbox pasan a un paquete que atraviesan tanto el agente (API) como el bot (worker, fase 3). `ErrorDeNegocio` baja a `core` para que las tres capas lancen la misma clase. Guarda nueva: `INSERT INTO messages` con `'outbound'` solo en ese paquete. **Sin cambio de comportamiento: los 123 tests de la API pasan sin tocarlos.**
- **PR-24, la bandeja se ajusta al agente** ([[web]]): separadores que se arrastran (ratón y teclado, `role="separator"`), lista y ficha plegables, preferencia recordada por navegador; la ficha pasa a cajón superpuesto por debajo de 1100 px y a pantalla completa en móvil, con aspa propia. Además: separadores de día en el hilo, la tira de vistas ya no se recorta y la conversación se centra en 64 rem cuando el hilo es muy ancho. 11 tests de web.
- **PR-23, panel de control y material de vidrio** ([[web]]): `GET /v1/panel` (sin responder, ventanas por cerrar, sin asignar, actividad del dia por canal, mediana de primera respuesta, uso del mes) y la pantalla que lo pinta, con lo accionable arriba y enlazado a la bandeja filtrada. Rehecho el material: fondo con tres focos frios, vidrio mas transparente y reflejo de borde. 5 tests de API.
- **PR-22, web de comentarios** ([[instagram]] §Señal de producto): la bandeja distingue hilos de comentarios (vista «Comentarios», etiqueta en la fila, cabecera sin ventana) y su compositor tiene dos acciones con consecuencias distintas — **«En privado» por defecto** (donde se captura el lead, como Kommo) y «En público». Un privado rechazado se explica sin alarmar y ofrece el público. La API expone `tipo` y `publicacionId` y filtra por `?tipo=`. 4 tests de web, 1 de API.
- **PR-21, el canal ya no se conecta sordo**: `conectarWhatsapp` **suscribe la WABA a nuestra app** (`POST /{waba-id}/subscribed_apps`) y guarda el resultado en `channel_accounts.webhook_subscribed` (migración 0014). Si el token no tiene permiso de gestión, el canal se conecta igual y la web avisa en rojo «No recibe mensajes»; renovar el token con permiso lo arregla sin reconectar. Además, el **`handle` de WhatsApp pasa a ser el teléfono** en vez del nombre de perfil (llegó un contacto real llamado «.»). 4 tests nuevos.
- **Prueba real de punta a punta** ([[whatsapp]] §Aprendizajes con tráfico REAL): entrante firmado → contacto, conversación, ventana de 24 h y uso medido; saliente desde el CRM → `delivered` confirmado por Meta. **El fallo que lo bloqueaba no era del código**: la WABA estaba suscrita a la app interna de pruebas de Meta, no a la del usuario (`POST /{waba-id}/subscribed_apps`).
- **PR-20, renovar credenciales**: `PATCH /v1/canales/:id/credenciales` verifica contra Meta antes de guardar, mantiene la MISMA cuenta (desconectar+reconectar habría perdido conversaciones y plantillas) y reconecta si estaba desconectada. `pnpm wa:conectar` renueva cuando el número ya está conectado; botón «Renovar token» en Ajustes → Canales. 5 tests.
- **PR-19, Instagram (fase 2)** ([[instagram]]): `AdaptadorInstagram` + `IngestaInstagram` dentro del contrato existente; DMs, adjuntos por URL de CDN, comentarios como hilos `comment_thread` por publicación; `comment_reply` (pública/privada) en la puerta de envío sin pasar por la ventana; conexión BYO `POST /v1/canales/instagram`; sandbox que imita las capacidades de cada canal. **`core` sin cambios.** 17 tests de canal, +3 worker, +5 API.
- **`pnpm demo:semilla`** (chore): seis conversaciones, cinco etiquetas y dos canales de ejemplo en la cuenta de desarrollo; idempotente; rehúsa correr con `NODE_ENV=production`.
- **PR-18, Ajustes en la web** ([[web]]): enrutado por hash sin dependencia (`#ajustes/<seccion>`), y cuatro secciones sobre la API existente: canales (conectar WhatsApp con los cuatro datos, desconectar), plantillas (sincronizar con Meta, estado con motivo de rechazo), respuestas rápidas (crear, editar → versión nueva, archivar) y uso del plan (barras contra `plans.limits`, ámbar al 80 %, rojo al 100 %). 21 tests en la web.
- **Contraseñas de rol unificadas** (chore): los tests usan `crmapp_dev`, la misma que `pnpm db:dev-roles`. Antes cada ejecución de tests dejaba la API de desarrollo sin poder conectar (los roles son del clúster). Verificado: tras la suite completa, la API en 3000 sigue respondiendo.
- **Prueba real en marcha**: número de prueba de Meta **conectado** (`POST /v1/canales/whatsapp` verificó contra Graph), `cloudflared` instalado, túnel activo y reto de verificación respondido a través de él. Falta que el usuario pegue URL y token en el panel de Meta y active el campo `messages`.
- **PR-17, `apps/web`** ([[web]], [[ADR-010-css-en-web]]): acceso y bandeja de tres paneles con vidrio iOS, tokens en `packages/ui`, etiquetas de color como filtro y franja (Zenvia), ventana de sesión pintada desde el instante de la API, compositor que obedece los 409 con `plantillasSugeridas`, respuestas rápidas con «/», adjuntos por subida directa, ficha de contacto (asignar, estado, etiquetas). P-23 resuelta. Guardas nuevas: nada en línea, sin CSS-in-JS, la web no importa `core`. 16 tests + capturas reales claro/oscuro en `adjuntos/`. Antes, `GET /v1/etiquetas` en la API.
- **PR-16, medición de uso** ([[uso]]): migración 0013 (`usage_events` particionada, `usage_event_keys`, `usage_rollups`), `registrarUso` en la transacción del hecho (entrantes, salientes aceptados, plantillas, conversaciones abiertas/reabiertas, bytes almacenados), `GET /v1/cuenta/uso` frente a `plans.limits` sin bloquear nada. De paso: **precreación diaria de particiones** desde el worker (función SECURITY DEFINER + `upsertJobScheduler`), que hasta hoy solo ocurría al migrar. 8 tests db, 5 worker, 3 API. **Qué se cobra sigue siendo P-21 (lista de parada).**
- **PR-15, plantillas** ([[plantillas]]): migración 0012 (`quick_replies`/`_versions`, `wa_templates`/`_versions`), sincronización de HSM desde el proveedor, webhook de estado de plantilla resuelto por WABA y reflejado por el worker, puerta de envío que exige `aprobada` y devuelve `plantillasSugeridas`, respuestas rápidas con versiones y adjunto. 20 tests nuevos en API, 2 en worker.
- **PR-14, multimedia** ([[ADR-009-medios]], [[medios]]): `packages/storage` (S3 por URL firmadas, nada público), descarga de entrantes por job propio con deduplicación por `sha256` dentro del inquilino, envío con `mediaAssetId` (la URL se firma en el worker al enviar), subida directa desde el navegador (`/v1/medios/subidas` → PUT → confirmar) y `GET /v1/medios/:id/url`. Se quitó la lectura anónima del bucket en el compose. MinIO en CI solo para `packages/storage`. 6 + 8 + 11 tests nuevos.

- Repositorio inicializado (`git init`, rama `main`). No es monorepo todavía: no hay `package.json`.
- Vault creado con contenido real: índice, este estado, preguntas abiertas, tres ADR en borrador y tres notas de canal.
- `.gitignore` y `.env.example` (solo nombres, cero valores).
- Inventario de skills hecho. Instalados `claude-security`, `frontend-design` y `feature-dev`. Ver [[2026-09-07]].
- **PR-13, conexión BYO**: `POST /v1/canales/whatsapp` verifica contra Meta y guarda cifrado; resolvers compartidos en `@crmapp/db` con el rol de solo lectura; API y worker usan el adaptador y la ingesta reales por defecto (sandbox solo con `modoSandbox`). Test de punta a punta: credenciales → webhook real firmado → inquilino correcto. 16 tests.
- **PR-12, WhatsApp real**: P-24 cerrado (vocabulario en inglés) y `AdaptadorWhatsapp` + `IngestaWhatsapp` implementando el contrato sin ampliarlo, con 23 tests sin red. **`ChannelAdapter` entra en la lista de parada.** Sin cablear aún: falta la conexión BYO (PR-13).
- **Arranque real verificado** (no solo tests): `pnpm dev:api` y `pnpm dev:worker` levantan con el `.env`; alta de cuenta por HTTP y `/v1/yo` con suscripción en prueba. Comandos en el README.
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

1. **Prueba con número real** (la hace el usuario): ya tiene app y número de prueba; `DEV_WA_*` y `META_WEBHOOK_VERIFY_TOKEN` están en su `.env`. Le falta `META_APP_SECRET`, el túnel, dar de alta el webhook y `pnpm wa:conectar` (orden completo en el README). Es el criterio de salida de fase 1 demostrado de verdad.
2. **Editor de HSM** (crear y enviar a revisión desde el CRM) y paginación de `syncTemplates`; ver pendientes en [[plantillas]].
3. Miniaturas/transcodificación en la cola `media` y CORS del bucket cuando llegue `apps/web`.
4. Smoke test de arranque en CI (lección del 2026-09-09).
5. ~~Web de comentarios~~ (hecho, PR-22). Siguiente: distinguir hilos de comentarios en la lista y ofrecer «responder en público / en privado» en el compositor.
6. WebSocket para no sondear; editor de HSM.
6. **Decidir P-21** (qué se cobra: asientos + IA por defecto según Kommo) y qué pasa al superar `conversaciones_mes`: hoy solo se muestra.
5. Pendiente de responder: P-04, P-05, P-06 y P-22 — con la señal de Kommo, P-04 y P-05 casi se responden solas.

## Cambio propuesto al plan de fases

Adelantar la **medición** de uso (`usage_events` y contadores) de fase 4 a fase 1, aunque cobrar siga en fase 4. Un evento de uso se emite en el mismo punto donde se envía el mensaje; añadirlo después obliga a volver a tocar todas las rutas de envío y deja el periodo anterior sin datos que reconstruir. Emitir desde el principio cuesta poco, retroactivar es imposible.

## Riesgo principal vigente

La dependencia de aprobaciones de Meta. **[[ADR-004-modelo-whatsapp]] lo reduce pero no lo elimina:** BYO-credentials evita el App Review del flujo de Embedded Signup y permite desarrollar y pilotar ya, con el cliente añadido como tester de nuestra app. Pero servir a clientes sin rol en esa app sigue exigiendo **Acceso Avanzado** a `whatsapp_business_messaging`, que pasa por revisión de Meta. La mitigación de fase 0 no cambia: adaptador con modo sandbox, para que ninguna fase dependa de credenciales reales.
