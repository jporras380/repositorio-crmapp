---
estado: vivo
fecha: 2026-09-09
modulo: plantillas
tags: [modulo, plantillas, whatsapp, hsm]
---

# Módulo: plantillas

Dos entidades, nunca un campo `tipo` (ARCH §5.6). Migración 0012.

## Plantillas de WhatsApp (HSM)

**El estado lo fija Meta; el CRM lo refleja.** Dos caminos para enterarse:

- **Sincronización** — `POST /v1/canales/:id/plantillas/sincronizar` (propietario, admin o supervisor). Llama a `syncTemplates` del adaptador **fuera** de la transacción, y después hace *upsert* en `wa_templates` con estado, categoría efectiva, calidad y motivo de rechazo. Una plantilla nueva crea `wa_template_versions` v1 (sin `components`: Meta no los devuelve en ese listado; los tendrá el editor cuando exista). No se deshabilitan las que Meta deja de devolver: el adaptador pagina de 100 y una cuenta grande haría parecer borradas plantillas vivas.
- **Webhook** `message_template_status_update` — llega con la WABA en `entry[].id`, sin `phone_number_id`. Por eso `crearResolverDeCuenta` resuelve también por `provider_account_id` (los números de una WABA comparten inquilino y app secret). El worker actualiza todas las cuentas del inquilino con esa WABA; si la plantilla no existía (creada en el panel de Meta), la registra. Publica `plantilla.actualizada` en el outbox para que la interfaz avise de pausas y rechazos.

**Puerta de envío.** `tipo: 'template'` exige que la plantilla exista sincronizada y esté `aprobada`: 422 `plantilla_desconocida` («sincroniza») o 422 `plantilla_no_aprobada` con `{estado, motivoDeRechazo}`. El mensaje guarda `wa_template_version_id`. Fuera de ventana, el 409 lleva `plantillasSugeridas` = aprobadas de esa cuenta.

`category_declared` y `category_effective` son columnas distintas: la efectiva es la que cuesta. Hoy solo se rellena la efectiva (viene de Meta); la declarada la rellenará el editor.

## Respuestas rápidas

Internas, sin aprobación, **solo con ventana abierta**: técnicamente son un mensaje libre. `POST/GET/PATCH/DELETE /v1/respuestas-rapidas`; atajo único entre las activas (`/gracias`); el borrado es archivado, y el atajo queda libre. Editar el contenido crea una versión nueva; título y atajo cambian en sitio. Pueden llevar un adjunto (`media_asset_id` ya almacenado, imagen/vídeo/audio/documento).

Enviar: `POST …/mensajes {tipo:'quick_reply', quickReplyId}` se expande en la API a texto (o medio con pie) y atraviesa la misma puerta que un texto; el mensaje guarda `quick_reply_version_id`.

## Cómo verificarlo en cinco minutos

```
pnpm --filter @crmapp/api test      # plantillas.e2e: sincronizar, sugerencias, 422, versiones de rápidas
pnpm --filter @crmapp/worker test   # webhook de plantilla: pausada y desconocida
pnpm --filter @crmapp/db test       # deriva del esquema y reversa de 0012
```

## Pendiente

- Editor de HSM (crear y enviar a revisión desde el CRM: `POST /{waba}/message_templates`) con `category_declared`, `components` y avisos sin bloquear.
- Paginación de `syncTemplates` (>100 plantillas) — toca el adaptador real, no el contrato.
- Aviso en la bandeja al recibir `plantilla.actualizada` (WebSocket, fase de web).

## Editor de plantillas (PR-48, 2026-09-16)

Hasta aquí las plantillas solo se sincronizaban: crearlas era ir al panel de Meta. Ahora se crean y se borran desde Ajustes → Plantillas.

- **El contrato `ChannelAdapter` no se tocó** (lista de parada). Crear plantillas es gestión de la WABA, no envío por un canal: vive en `apps/api/src/plantillas/editor-de-meta.ts`, como el descubridor de cuentas. Endpoints documentados: `POST /{waba}/message_templates` y `DELETE …?name=&hsm_id=`.
- **Valida antes de gastar un intento.** Cada envío a Meta es una espera de revisión, así que lo que Meta rechaza SIEMPRE por forma —nombre con mayúsculas, variable sin ejemplo, variables con saltos— es **error** y no sale de aquí. Lo que suele rechazar —enlaces acortados, variable pegada al borde, promoción declarada como utilidad— es **aviso**: se advierte y se deja intentar, porque quien aprueba es Meta ([[whatsapp]] §Causas frecuentes de rechazo). La regla vive en `core/plantillas.ts` y la usan el servidor y la pantalla.
- **La categoría efectiva es la que devuelve Meta al crearla**, no la declarada: es la que determina el costo, y confundirlas es facturar mal.
- **Borrar no borra la fila**: la quita de Meta y aquí queda `deshabilitada`. Los mensajes enviados apuntan a su versión; perderla sería perder el historial de lo que se le dijo a un huésped.
- Un canal sin token conectado responde 409 con qué hacer, no un error 500.
- **Sin probar contra Meta real:** hace falta una WABA con permiso de gestión.
