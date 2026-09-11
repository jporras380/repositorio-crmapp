---
estado: vivo
fecha: 2026-09-11
modulo: meta
tags: [referencia, wacrm, vocero, idurar, licencias, comparativa]
---

# Los tres CRM de referencia, leídos

Clonados en `../crmapp-references/` (fuera del árbol del proyecto, `--depth 1`). **Se leen; no se copia código.**

## Licencias, antes que nada

| Repo | Licencia | Qué implica |
|---|---|---|
| `ArnasDon/wacrm` | **MIT** | Copiar sería legal con atribución. No hace falta: el stack no encaja. |
| `kevinrivm/vocero-crm` | **MIT** | Igual. |
| `idurar/idurar-erp-crm` | **AGPL-3.0** | **Copiar una línea obligaría a publicar todo nuestro CRM bajo AGPL**, self-hosted incluido. Se lee y se cierra. |

Ninguno encaja por dentro: Next.js + Supabase, Next.js + Better Auth, y MERN + MongoDB. Lo aprovechable son **ideas de producto y trampas ya pisadas**, no código.

## WACRM — lo que enseña

**Es de un solo canal, y se nota en el esquema.** `contacts.phone` ES la identidad: no hay separación entre la persona y su identidad en el canal. Añadir Instagram exigiría rehacer contactos, conversaciones y mensajes. Es la confirmación empírica de [[ADR-007-identidad-contactos]].

**La multi-tenencia llegó tarde.** Empezó con `user_id` por fila y se reconvirtió a cuentas en la migración 017; el parche se ve repartido por veinte migraciones posteriores. Nosotros tenemos inquilinos desde la 0002.

**Su motor de automatizaciones corre con el cliente de servicio, que salta RLS**, y comprueba la pertenencia a mano en código — lo dice su propio comentario. Un olvido es una fuga entre clientes. Es exactamente lo que [[ADR-005-rls]] evita: nuestro motor corre bajo RLS con `SET LOCAL`.

**Lo que tienen y nos falta, por orden de valor:**

1. **Mensajes interactivos de WhatsApp** (botones y listas) y un disparador `interactive_reply`. Para un hotel es enorme: «Ubicación · Precios · Reservar» como botones evita media conversación. El contrato `ChannelAdapter` ya modela capacidades, así que cabe sin tocarlo.
2. **Campos personalizados** (`custom_fields` + `contact_custom_values`), genéricos por cuenta.
3. **Tope de profundidad en cadenas de etiquetas** (`MAX_TAG_CHAIN_DEPTH`): una automatización disparada por «etiqueta añadida» que añade otra etiqueta se llama a sí misma. Es el primo del `bucle_sin_espera` que ya validamos, y lo pisaríamos el día que añadamos ese disparador.
4. **Comprobación anti-SSRF** en el paso «llamar a un webhook». Si algún día ofrecemos webhooks salientes, esto no es opcional.
5. Difusiones con reanudación, claves de API, notificaciones, presencia de agentes, reacciones.

Su catálogo de pasos: `send_message`, `send_buttons`, `send_list`, `send_template`, `send_webhook`, `wait`, `condition`, `tag`, `update_contact_field`, `create_deal`, `assign_conversation`. El nuestro tiene siete; los que faltan y merecen la pena son **cambiar un campo del contacto** y **crear un lead**.

## VOCERO — el más parecido a nosotros

Postgres + Drizzle + TypeScript estricto. Es el que más se puede comparar de tú a tú.

**Llegaron a la misma solución que el relevo de PR-32, por su cuenta:** cuando el dueño responde a mano, `ai_enabled = false`, `handoff_at = now()`, y el `UPDATE` lleva `WHERE handoff_at IS NULL` para ser atómico e idempotente. Confirmación independiente de que el diseño es el correcto.

**Y tienen algo que nosotros no: `handoff_reason`.** Saber *por qué* se calló el bot —respuesta manual, palabra clave, escalado de la IA— es la diferencia entre un soporte que contesta y uno que investiga. Lo adopto.

**Idempotencia:** `UNIQUE(wa_message_id)` y `ON CONFLICT DO NOTHING`. Simple porque **no particionan** `messages`. Nosotros no podemos: un índice único en tabla particionada debe incluir la columna de partición, y por eso existe `message_keys` ([[ADR-006-particionado-idempotencia]]). Su simplicidad es el precio que pagamos por poder borrar millones de filas con `DETACH PARTITION`.

**Webhook, dos capas:** un token secreto en la ruta (`/api/webhooks/wa/[token]`) y la firma HMAC — pero **la firma solo se comprueba si hay `META_APP_SECRET` configurado**. La nuestra se comprueba siempre, sobre los bytes crudos, y el crudo se persiste aunque la firma falle. Su token en la URL sí resuelve algo elegante: saber de qué organización es el webhook sin mirar el contenido.

**Dónde son más frágiles:** procesan el webhook en un `after()` de Next.js, en el mismo proceso. Si el proceso muere, el evento se perdió. Nosotros escribimos `inbound_events` primero y procesa el worker, con reintentos.

**Su modelo de reservas, que es justo el siguiente PR:** `booking` con `contact_id`, `conversation_id` **y** `lead_id`, más `status`, `source` y `is_test`. Y `offered_slot`, que guarda **lo que el bot ofreció** para poder validar lo que el cliente elige después. Para el hotel, eso es «te ofrecí estas tres fechas» y vale su peso en oro.

`kb_entry` (pregunta/respuesta/contenido) es una base de conocimiento **sin embeddings**: texto plano inyectado en el prompt. Barato y suficiente; cierra P-12 sin pgvector.

`agent_test_case` + `agent_test_run`: un laboratorio que corre clientes simulados contra la IA **antes** de que hable con gente real. Es la mejor idea de los tres repos.

Y un contraste: su `lead` tiene `position`, o sea que **sí guardan el orden manual dentro de la etapa**. Nosotros no ([[ADR-013-lead-no-es-conversacion]]). Es una decisión con costo, no un olvido.

## IDURAR — solo la forma

Lo único que hacía falta mirar es cómo modelan una cotización: **líneas** (`items[]` con nombre, cantidad, precio y total), y encima `subTotal`, `taxTotal`, `total`, `currency`, `paymentStatus` (unpaid/paid/partially) y `converted.from` para saber que una factura nació de una cotización.

La lección para el módulo de reservas: el `amount_cents` del lead sirve para el pronóstico del embudo, pero **una cotización de hotel tiene líneas** —tres noches de Familiar VIP, más desayunos— y eso pertenece a la reserva, no al lead. Es una razón más para que sean dos entidades.

## Qué cambia en el plan

- **PR-32 (hecho):** añadir `handoff_reason` al relevo. Barato y se agradece en soporte.
- **PR-34 (clientes):** columnas tipadas para lo que el hotel usa siempre; los campos personalizados genéricos esperan a que un segundo cliente los pida.
- **PR-37 (reservas):** con **líneas**, y guardando lo cotizado, no solo el total.
- **Candidato nuevo:** mensajes interactivos de WhatsApp (botones y listas). Es la mejora de atención más barata que he visto en los tres.
- **Cuando toque:** anti-SSRF en webhooks salientes y tope de profundidad si añadimos disparadores por etiqueta.
