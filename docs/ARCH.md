# ARCH — CRM conversacional omnicanal

> Estado: **propuesta**, pendiente de aprobación. Hasta que se apruebe, no hay código de producto (regla 10).
> Fecha: 2026-09-07 · El *porqué* de cada decisión vive en [vault/decisiones/](vault/decisiones/). Este documento describe el *qué*.
> Cuando exista código, **las migraciones mandan sobre la sección 5**. Si divergen, el documento está mal.

---

## 1. Alcance

CRM conversacional multi-inquilino (SaaS) que centraliza DMs y comentarios de WhatsApp, Instagram y TikTok en una bandeja única, con automatizaciones, plantillas, gestión de usuarios y facturación por plan.

Plataformas por orden: **Web (única del MVP)** → Android (React Native) → iOS.

**No negociable:** cero lógica de negocio en el frontend. Toda regla —ventanas de sesión, permisos, límites de plan— se aplica en la API. El frontend pinta estado, no lo decide.

## 2. Supuestos explícitos

P-04, P-05 y P-06 siguen sin respuesta y se ordenó proceder. El ARCH se escribe bajo estos supuestos. **Cada uno lleva el umbral en el que deja de valer**, que es la parte útil.

| # | Supuesto | Deja de valer cuando | Qué habría que rehacer |
|---|---|---|---|
| **S-1** (P-04) | Despliegue en **una sola región**, con el marco más estricto aplicable (GDPR) como línea base: si se cumple GDPR, se cumplen LFPDPPP y equivalentes. La región es configuración de despliegue, no está incrustada en el código. | Un cliente exige residencia de datos en otra jurisdicción. | Multi-región es cambio de topología, no de esquema. Duele, pero el esquema sobrevive. |
| **S-2** (P-05) | **Producto especulativo**, sin cliente firmado. El primer cliente será piloto acompañado, así que el alta manual del ADR-004 es aceptable. Se mantiene el orden de fases. | Aparece un cliente firmado con fecha. | El orden de fases pasa a mandarlo él. Posible adelanto de Embedded Signup. |
| **S-3** (P-06) | Escala año 1 **modesta**: menos de 100 inquilinos, menos de 5 M mensajes/mes, pico bajo 50 msg/s. | Más de 20 M mensajes/mes, **o** pico sobre 200 msg/s, **o** el panel degrada la latencia de la bandeja. | Réplica de lectura y revisión del semáforo de colas. Ambas aditivas: ninguna obliga a migrar datos. |

**S-3 es el supuesto que más decide en este documento.** Justifica: una sola instancia de PostgreSQL sin réplica de lectura, vistas materializadas en lugar de almacén analítico separado, particiones mensuales (no semanales) para `messages`, y un solo Redis.

## 3. Principios

1. **El estado del proveedor se sincroniza, no se asume.** Estado de plantilla, categoría efectiva, calidad del número, límite de envío: todo es columna sincronizada por webhook, nunca constante en código. Es la mitigación estructural del riesgo principal del proyecto.
2. **El núcleo no conoce canales.** Habla con `ChannelAdapter`. Un cuarto canal es un paquete nuevo, no un `if` más.
3. **Nada se pierde entre el commit y la cola.** Patrón outbox, desde fase 0, sin excepciones y sin parches posteriores.
4. **El webhook no procesa.** Valida firma, persiste crudo, encola, responde 200 en menos de un segundo.
5. **El aislamiento es de la base de datos, no de la aplicación.** RLS con `FORCE`. Un `WHERE tenant_id` olvidado no debe poder filtrar datos.
6. **Todo lo caro se mide cuando ocurre**, no se reconstruye después contando filas.

## 4. Componentes

```
apps/
  api/           NestJS. HTTP + WebSocket. No habla con proveedores externos.
  worker/        NestJS standalone. Consumidores BullMQ, relay del outbox, cron de rescate.
  web/           React + Vite.
  mobile/        Fase 6.
packages/
  contracts/     Zod + DTOs + OpenAPI. Fuente de verdad del contrato de API.
  db/            Esquema Drizzle, migraciones SQL, políticas RLS, seeds.
  channels/      ChannelAdapter + registry + un subdirectorio por canal.
  core/          Dominio puro, sin I/O: ventanas, políticas de envío, errores tipados.
  envio/         La puerta de envío: la atraviesan el agente (API) y el bot (worker).
  queue/         Colas y jobs tipados; outbox.
  crypto/        Envelope encryption; redacción de logs.
  observability/ Logger, trazas, métricas.
  config/        Validación de entorno con Zod; falla al arrancar, no en caliente.
  ui/            Tokens de diseño y componentes.
infra/           docker-compose de desarrollo: postgres, redis, minio, mailhog.
```

**Un mensaje sale por un solo sitio.** La puerta de envío —suscripción, estado, ventana, capacidades, outbox— vive en `packages/envio` y no en la API, porque desde la fase 3 hay un segundo remitente que no es un agente humano: el Salesbot, que corre en el worker. Duplicar la puerta sería duplicar la regla de la ventana de 24 h, y el día que una copia se corrija y la otra no, el bot envía fuera de política sin que nadie lo vea. Lo vigila una guarda: `INSERT INTO messages` con `outbound` solo puede aparecer en ese paquete.

**`core` no importa nada con I/O.** Es lo que hace cumplible el "cero lógica de negocio en el frontend": si la ventana de sesión se calcula en `core` y `web` no puede importarlo, no acaba en React por accidente. Se vigila con lint, no con buena voluntad.

**`api` y `worker` son procesos separados desde el día uno.** Un pico de ingesta no puede degradar la latencia del WebSocket de la bandeja. Costo: dos despliegues y el riesgo de duplicar bootstrap.

## 5. Modelo de datos

PostgreSQL. Toda tabla de inquilino lleva `tenant_id uuid not null` y RLS forzada. Claves primarias UUID v7: ordenables en el tiempo, evitan la fragmentación de índice que causa v4.

### 5.1 Inquilinos, usuarios y permisos

| Tabla | Notas |
|---|---|
| `tenants` | Cuenta cliente. `status`, `plan_id`. |
| `users` | Identidad global, email único global. Un usuario puede estar en varios inquilinos (agencias). Sin `tenant_id`: no lleva RLS de inquilino. |
| `memberships` | `(tenant_id, user_id, role)`, único. **El rol vive aquí, no en `users`.** |
| `teams`, `team_members` | |
| `business_hours` | `(tenant_id, team_id, timezone, schedule jsonb)`. La zona horaria es del equipo, no del servidor. |
| `invitations` | Token de un solo uso, con caducidad. |
| `audit_log` | Quién vio qué conversación, quién exportó, quién tocó facturación. **Particionada por mes.** Solo inserción: al rol de aplicación no se le conceden `UPDATE` ni `DELETE`. |

### 5.2 Canales

| Tabla | Notas |
|---|---|
| `channel_accounts` | `(tenant_id, channel, external_id, display_name, status, quality jsonb, limits jsonb, last_synced_at)`. `external_id` es `phone_number_id` en WhatsApp, `ig_user_id` en Instagram. Único `(channel, external_id)` **global**: un número no puede estar en dos inquilinos. |
| `channel_secrets` | `(channel_account_id, kind, ciphertext bytea, dek_wrapped bytea, key_version, rotated_at)`. Ver §11. **Nunca** tokens en `channel_accounts`. |

`quality` y `limits` son `jsonb` a propósito: su forma la dicta Meta y cambia sin avisarnos. Modelarlos en columnas sería inventar un esquema sobre datos ajenos.

### 5.3 Identidad de contactos

| Tabla | Notas |
|---|---|
| `contacts` | **La persona.** Sin identificador de canal. `display_name`, `attributes jsonb`. |
| `contact_identities` | **El hecho del proveedor.** `(tenant_id, contact_id, channel, channel_account_id, external_user_id, handle, profile jsonb)`. Único `(channel_account_id, external_user_id)`. |
| `contact_merges` | `(source_contact_id, target_contact_id, merged_by, at, reason)`. Toda fusión deja rastro y es reversible. |

Ver ADR-007.

### 5.4 Conversaciones y mensajes

| Tabla | Notas |
|---|---|
| `conversations` | `contact_identity_id` (el hilo es del canal), `contact_id` (desnormalizado para la vista unificada), `channel_account_id`, `kind` (`dm` o `comment_thread`), `status` (`open`, `pending`, `snoozed`, `closed`), `assignee_user_id`, `team_id`, `last_inbound_at`, **`session_expires_at`**, `first_response_at`, `closed_at`, `external_thread_id`. |
| `messages` | **Particionada por rango de `created_at`, mensual.** PK `(created_at, id)`. `direction`, `type`, `body`, `payload jsonb`, `external_message_id`, `status` (`queued`, `sent`, `delivered`, `read`, `failed`), `error jsonb`, `sent_by` (`human`, `bot`, `ai`, `system`), `ai_generated`, `wa_template_version_id`, `quick_reply_version_id`. |
| `message_keys` | **No particionada.** `(channel_account_id, external_message_id)` único, apunta a `message_id` y `created_at`. Es el registro de idempotencia. Ver ADR-006. |
| `media_assets` | `storage_key`, `sha256`, `mime`, dimensiones, `duration_ms`, `remote_url`, `remote_expires_at`, `status` (`pending`, `stored`, `failed`), `thumb_key`. |
| `internal_notes` | |
| `tags`, `conversation_tags`, `contact_tags` | |

Índices que importan, no todos los que habrá:

- `conversations (tenant_id, status, last_inbound_at DESC)` — la consulta de la bandeja, la más caliente del producto.
- `conversations (tenant_id, assignee_user_id, status)` — "mis conversaciones".
- `conversations (tenant_id, session_expires_at)` parcial `WHERE status <> 'closed'` — el aviso de ventana por expirar.
- `messages (conversation_id, created_at DESC)` en cada partición.

**Invariante de `session_expires_at`:** lo escribe el servidor al ingerir un entrante, con la política del adaptador del canal. Guarda un instante, no unas horas — la duración es del canal y puede cambiar. El envío libre se rechaza comparando contra esta columna, nunca contra el reloj del cliente.

### 5.5 Ingesta y publicación

| Tabla | Notas |
|---|---|
| `inbound_events` | Crudo del webhook, `signature_ok`, `status`, `attempts`. **Se escribe antes de procesar.** Particionada por semana, retención corta. |
| `outbox` | `(aggregate_type, aggregate_id, event_type, payload jsonb, created_at, published_at, attempts)`. Índice parcial `WHERE published_at IS NULL`. |
| `webhook_endpoints`, `webhook_deliveries` | Salientes con firma HMAC y reintentos. |

### 5.6 Plantillas — dos entidades, nunca un campo `tipo`

| Tabla | Notas |
|---|---|
| `quick_replies`, `quick_reply_versions`, `quick_reply_attachments` | Internas del CRM. Sin aprobación externa, disponibles al instante. Solo usables con ventana abierta: técnicamente son mensajes libres. |
| `wa_templates` | `(tenant_id, channel_account_id, name, language, category_declared, category_effective, status, meta_template_id, quality_score, paused_until, last_synced_at)`. Único `(channel_account_id, name, language)`. |
| `wa_template_versions` | `(template_id, version, components jsonb, example_params jsonb, status, meta_template_id, submitted_at, reviewed_at, rejection_reason)`. |

**`category_declared` y `category_effective` son columnas distintas.** La primera la declara el usuario; la segunda la fija Meta y **es la que determina el costo**. Confundirlas es facturar mal.

**`messages` referencia la _versión_, jamás la plantilla.** Es lo que permite que una conversación histórica siga mostrando el texto realmente enviado. Editar una plantilla crea versión y archiva la anterior; en WhatsApp, además, la devuelve a revisión.

**Estados y su origen:** `borrador` es nuestro. `en_revision`, `aprobada`, `rechazada`, `pausada` y `deshabilitada` los fija Meta y llegan por webhook. Una aprobada puede pausarse después si los usuarios la reportan: el CRM se entera y avisa. `rejection_reason` se guarda y se muestra — es lo único que permite corregir.

El editor refleja la estructura de Meta (cabecera, cuerpo, pie, botones) con sus límites de caracteres, no es un textarea libre, y **advierte sin bloquear** sobre las causas frecuentes de rechazo. La decisión es de Meta; bloquear de más es peor que dejar intentarlo.

### 5.7 Salesbots

| Tabla | Notas |
|---|---|
| `flows`, `flow_versions` | `graph jsonb`. Versión publicada apuntada desde `flows.current_version_id`. |
| `flow_triggers` | `(type, config jsonb, enabled)`. |
| `flow_runs` | `flow_version_id` **(no `flow_id`)**, `conversation_id`, `status`, `current_node_id`, `wait_until`, `wait_for`, `context jsonb`. Índice parcial `WHERE status = 'waiting'`. Único parcial `(conversation_id, flow_id) WHERE status IN ('running','waiting')`. |
| `flow_run_steps` | El log paso a paso: `node_id`, `input`, `output`, `error`, `at`. |

`flow_runs` apunta a la **versión**: los runs en vuelo terminan con la versión con la que empezaron. Ver ADR-002.

### 5.8 IA

| Tabla | Notas |
|---|---|
| `ai_configs` | `provider`, `model`, `byok`, `key_secret_id`, `tone`, `guardrails jsonb`, `monthly_budget_cents`, `current_version_id`. |
| `ai_config_versions` | `system_prompt`, `created_by`. **Cambiar el prompt crea versión, no sobrescribe.** |
| `ai_knowledge_docs` | Depende de P-12. Si es RAG, `pgvector`; si no, texto inyectado. |
| `ai_invocations` | `purpose`, `model`, tokens de entrada y salida, `cost_cents`, `latency_ms`, `config_version_id`. Alimenta `usage_events`. |

Barandas obligatorias, aplicadas en servidor: techo de gasto mensual por cuenta, derivación a humano ante tema fuera de alcance, y la IA nunca confirma precios ni pedidos por su cuenta.

### 5.9 Facturación y medición

| Tabla | Notas |
|---|---|
| `plans` | Catálogo **global**, sin `tenant_id`. `limits jsonb`, precios, `trial_months`, `grace_days`. Lleva RLS con política de lectura pública y solo `SELECT` para la aplicación: ningún inquilino puede inventarse un plan a su medida. |
| `subscriptions` | Una por inquilino. `status`, `trial_ends_at`, `current_period_ends_at`, `grace_days`, y `cached_state` como **caché**. Referencias al proveedor de pagos (P-10). |
| `usage_events` | `(tenant_id, metric, quantity, occurred_at, dedup_key único, meta jsonb)`. **Particionada por mes.** |
| `usage_rollups` | `(tenant_id, metric, period, quantity)`. Agregada por job. |
| `invoices` | |

**La factura se calcula sobre `usage_rollups`, jamás contando filas de `messages`.**

Con ADR-004, las métricas que quedan son **asientos** y **consumo de IA** — lo único donde le pagamos a un proveedor. El costo de mensajería de WhatsApp no pasa por nosotros. Ver P-21.

### 5.10 Panel

Vistas materializadas (`mv_conversation_metrics_daily`, `mv_agent_metrics_daily`) refrescadas con `REFRESH MATERIALIZED VIEW CONCURRENTLY` desde un job. **La analítica no toca tablas transaccionales en caliente.** Bajo S-3 esto basta; si S-3 se rompe, réplica de lectura.

## 6. Multi-tenancy y aislamiento

RLS con `ENABLE` y `FORCE` en toda tabla con `tenant_id`. Política `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`.

- Un **único rol de aplicación**, que **no es owner** de las tablas. Las migraciones corren con otro rol.
- `SET LOCAL app.tenant_id` por transacción, puesto por un interceptor de NestJS sobre `AsyncLocalStorage`.
- **`SET` sin `LOCAL` prohibido por lint**: con pooler en modo transacción, un `SET` se filtraría a la siguiente conexión prestada.
- **Dos tests que deben existir antes que cualquier endpoint:** uno que falle si alguna consulta llega a la base sin `app.tenant_id`; otro que recorra el catálogo de PostgreSQL y falle si existe una tabla con columna `tenant_id` sin RLS forzada. Sin ellos, esta sección es una promesa, no un mecanismo.

Ver ADR-005.

## 7. Ingesta de webhooks

1. Validar firma. Firma inválida devuelve 401 y se registra; no se procesa.
2. `INSERT` en `inbound_events` con el crudo.
3. Encolar en `inbound-ingest`.
4. Responder 200 en menos de un segundo.

El worker deduplica contra `message_keys`, resuelve o crea `contact_identities` y `conversations`, escribe el mensaje, recalcula `session_expires_at` y escribe en `outbox` — **todo en una transacción**.

**Reenvíos (requisito 8.1):** gana el primero para el contenido; upsert solo de campos mutables, es decir estado de entrega y marcas de leído. El cuerpo de un mensaje no cambia, su estado sí. Un reenvío con cuerpo distinto se marca como anomalía en `inbound_events` y **se alerta**, no se sobrescribe en silencio.

**Alerta de silencio:** si un `channel_account` deja de recibir eventos durante N minutos (P-20, por defecto 15), se alerta. Un canal caído en silencio es el peor fallo de este producto.

## 8. Contrato de adaptador de canal

```
sendText · sendMedia · sendTemplate · replyToComment · fetchMedia · syncTemplates
capabilities()    qué soporta este canal
sessionPolicy()   cómo se calcula la ventana y qué permite
```

El núcleo **pregunta capacidades, no asume**. TikTok no tiene plantillas y puede no tener ventana; Instagram limita la respuesta privada a una por comentario. Si el núcleo asume el modelo de WhatsApp, el tercer canal obliga a tocarlo.

**Cambiar este contrato una vez implementado el primer canal está en la lista de parada.** La prueba de que la abstracción es correcta llega en fase 2 con Instagram, no en fase 7 con TikTok.

**Modo sandbox obligatorio en todos los adaptadores** desde fase 0: simula respuestas del proveedor para que ninguna fase dependa de credenciales reales. Es la mitigación del riesgo principal del proyecto.

## 9. Envío y ventanas

Un envío atraviesa, en este orden: permisos → **estado de la suscripción** → estado de la conversación → **ventana de sesión** → capacidad del canal → límites de plan → cola de salida del canal.

### Estado de la suscripción

Prueba de un mes; al caducar sin pagar, **siete días de gracia** en los que solo se envía texto —sin imagen, vídeo, audio, documento ni plantillas—; pasada la gracia, **suspensión**: no se envía nada, **las cuentas de canal se desconectan del proveedor** y la cuenta queda en solo lectura para consultar y exportar el historial. La no renovación de un plan pagado sigue el mismo camino.

Dos invariantes que hay que respetar:

- **El estado efectivo se deriva de las fechas, no de la columna `status`.** Esa columna es una caché que mantiene un job; confiar en ella deja una ventana en la que un cliente cuya gracia venció a las 3 de la mañana sigue enviando hasta el siguiente cron.
- **Al suspender se desconecta el canal en el proveedor, no se rechazan sus webhooks.** Rechazarlos provoca reintentos de Meta y, sostenido, puede llevar a que desactive nuestro webhook. Desconectar hace que deje de enviarlos.

La lógica vive completa en `packages/core` y es dominio puro. `apps/web` no puede importarlo, así que no hay forma de recuperar el envío de imágenes desde el frontend.

Fuera de ventana, el envío libre se rechaza con un error tipado que **incluye las plantillas aprobadas aplicables**. El frontend no decide esto: recibe la sugerencia y la pinta.

Backoff exponencial por canal, respetando límites de tasa. El límite vigente sale de `channel_accounts.limits`, sincronizado, no codificado.

## 10. Colas

Colas por clase de trabajo: `inbound-ingest`, `outbound-<canal>`, `media`, `flows`, `ai`, `outbox-relay`, `maintenance`.

Aislamiento por semáforo de concurrencia por inquilino en Redis, con TTL para que un worker muerto no bloquee al cliente indefinidamente. Escotilla: mover un inquilino a cola dedicada debe ser configuración, no arquitectura. Ver ADR-003.

**El reintento por saturación se cuenta aparte del reintento por error.** Mezclarlos hace que las alertas mientan.

## 11. Secretos

Envelope encryption: una clave maestra en entorno envuelve una DEK por secreto, y se guarda `key_version` por fila para poder rotar sin reescribir todo.

- Tokens de canal y claves BYOK de clientes cifrados; nunca en texto plano en base ni en logs.
- **Redacción en el logger, con test que lo compruebe**: inyectar un token conocido y fallar si aparece en la salida.
- `.env.example` con nombres, sin valores. Cero credenciales en el repositorio.

## 12. Multimedia

- **WhatsApp** entrega `media_id` con URL firmada de vida corta: descarga inmediata a almacenamiento propio. `remote_expires_at` hace visible la caducidad.
- **Instagram** exige URL pública para salientes, así que el almacenamiento debe poder exponer una URL firmada accesible desde fuera. No todo puede ser privado.
- Transcodificación y miniaturas en background, cola `media`.
- Validación de tamaño y tipo **por canal, antes de enviar**. Cada canal tiene límites distintos y descubrirlos en el error del proveedor es tarde.
- `sha256` para deduplicar: el mismo archivo enviado a 500 contactos se almacena una vez.

## 13. Observabilidad

Logs estructurados con `tenant_id` y `correlation_id` a lo largo de todo el recorrido. Trazas del camino webhook → worker → envío. Métricas por canal: latencia de ingesta, profundidad de cola, tasa de fallo, antigüedad del outbox sin publicar.

Alertas: webhook en silencio (§7), outbox con retraso creciente, calidad de número degradada, plantilla pausada por Meta, presupuesto de IA al 80 %.

## 14. Privacidad

Las conversaciones son datos personales. Retención configurable (P-07), exportación y borrado por solicitud del titular. El borrado alcanza a `messages`, a `media_assets` en el almacén de objetos y a `inbound_events`. El `audit_log` conserva el hecho del borrado, no el contenido.

**El contenido del cliente entra al prompt de IA como dato, nunca como instrucción.** Todo mensaje generado por IA queda marcado en base (`sent_by = 'ai'`, `ai_generated = true`).

## 15. Fases

| Fase | Contenido | Criterio de salida |
|---|---|---|
| 0 | Monorepo, CI, esquema base, auth, multi-tenancy con RLS, outbox, adaptador en sandbox | Crear cuenta e invitar usuario. **Los dos tests de RLS de §6 pasan en CI.** |
| 1 | WhatsApp (BYO-credentials), webhooks, bandeja, multimedia, ambos tipos de plantilla, **`usage_events`** | Un agente atiende WhatsApp de punta a punta |
| 2 | Instagram DM y comentarios, identidad unificada | Dos canales en una bandeja **sin haber tocado `core`** |
| 3 | Salesbots con estado persistido | Un flujo real califica un lead sin humano y sobrevive a un deploy — **cumplido** (`apps/worker/test/flujos.test.ts`) |
| 4 | Panel y facturación | Se puede cobrar — **cumplido** con cobro manual por asiento ([[ADR-011]]; `apps/api/test/suscripcion.e2e.test.ts`) |
| 5 | Capa de IA configurable | El cliente enciende la IA desde la interfaz |
| 6 | Android | Agentes responden desde el móvil |
| 7 | TikTok e iOS | Cobertura completa |

**Único cambio respecto al plan original:** la **medición** de uso (`usage_events`) se adelanta de fase 4 a fase 1. Se emite en el mismo punto donde se envía el mensaje; añadirla después obliga a volver a tocar todas las rutas de envío y deja el periodo anterior sin datos que reconstruir. Cobrar sigue en fase 4.

El criterio de salida de fase 2 es el que de verdad valida la arquitectura: si Instagram entra sin tocar `core`, el adaptador está bien planteado.

## 16. Riesgos

1. **Aprobaciones de Meta** — el riesgo principal. Mitigado con sandbox y estado sincronizado; reducido, no eliminado. Detalle en [vault/canales/whatsapp.md](vault/canales/whatsapp.md).
2. **Alcance** — ocho módulos, tres plataformas, un implementador. Mitigación: criterios de salida por fase que sean demostrables, no opinables.
3. **RLS mal aplicada** — el fallo más caro posible en un SaaS multi-inquilino: una fuga entre clientes. Mitigación: los dos tests de §6 como bloqueo de CI desde fase 0.
4. **Deriva entre este documento y el código** — mitigación: las migraciones mandan; este documento se corrige o se marca obsoleto.

## 17. Decisiones registradas

| ADR | Tema |
|---|---|
| [ADR-001](vault/decisiones/ADR-001-orm.md) | ORM: Drizzle |
| [ADR-002](vault/decisiones/ADR-002-motor-salesbots.md) | Motor de Salesbots: máquina de estados propia |
| [ADR-003](vault/decisiones/ADR-003-estrategia-colas.md) | Colas por función con semáforo por inquilino |
| [ADR-004](vault/decisiones/ADR-004-modelo-whatsapp.md) | WhatsApp por BYO-credentials |
| [ADR-005](vault/decisiones/ADR-005-rls.md) | RLS por `SET LOCAL` en transacción |
| [ADR-006](vault/decisiones/ADR-006-particionado-idempotencia.md) | Particionado de `messages` e idempotencia |
| [ADR-007](vault/decisiones/ADR-007-identidad-contactos.md) | Identidad unificada de contactos |
| [ADR-011](vault/decisiones/ADR-011-modelo-de-cobro.md) | Cobro por asiento, manual, con la mensajería fuera |
