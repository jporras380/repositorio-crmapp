---
estado: vivo
fecha: 2026-09-09
modulo: medios
tags: [modulo, medios, s3]
---

# Módulo: medios

Decisiones en [[ADR-009-medios]]. Aquí, cómo funciona y cómo se prueba.

## Flujos

**Entrante.** `procesar-entrante` ve `mediaId` en un mensaje de tipo medio → `media_assets` en `pending` + `messages.media_asset_id` + evento `media.descargar` en el outbox (misma transacción). El relay lo publica en la cola `media`; `descargar-media` hace `fetchMedia`, calcula `sha256`, reutiliza la clave si el inquilino ya tiene esos bytes, guarda y marca `stored` con un `UPDATE … WHERE status <> 'stored'` (dos jobs simultáneos: uno gana). Fallo no reintentable del proveedor → `failed`; reintentable → el job relanza y BullMQ reintenta.

**Saliente propio.** La API acepta `mediaAssetId` en lugar de `url`; comprueba que existe (RLS) y está `stored`; el outbox lleva `url: null, mediaAssetId`. El worker firma la URL (1 h) justo antes de `sendMedia`.

**Subida.** `POST /v1/medios/subidas {mime, bytes}` → 201 `{mediaAssetId, urlDeSubida}`. El navegador hace `PUT` a esa URL. `POST /v1/medios/subidas/:id/confirmar` → `HEAD` al objeto; si no está, 409 `subida_incompleta`.

**Lectura.** `GET /v1/medios/:id/url` → `{url, expiraEnSegundos: 300, mime}`. 409 si aún se procesa, 410 si falló, 404 si no es tuyo. El listado de mensajes trae `medio_id` y `medio_estado` para que la bandeja sepa si pedir la URL o mostrar «procesando».

## Límites

MIME permitidos en subida: jpeg, png, webp, mp4, 3gpp, ogg, mpeg, mp4 audio, aac, amr, pdf. Máximo 100 MB. Los límites **por canal** (WhatsApp: 5 MB imagen, 16 MB vídeo/audio, 100 MB documento) los aplica `validarContraCapacidades` al enviar, no la subida.

## Sin S3 configurado

API: rutas de medios responden 503 `almacenamiento_no_configurado`. Worker: arranca con aviso; los medios entrantes quedan `pending` y el job de descarga falla y reintenta hasta que haya almacén. Todo lo demás funciona.

## Cómo verificarlo en cinco minutos

```
pnpm --filter @crmapp/storage test    # contra MinIO real: PUT/GET firmados
pnpm --filter @crmapp/worker test     # descargar-media + entrante con medio + saliente con medio propio
pnpm --filter @crmapp/api test        # medios.e2e: subida, confirmación, envío, URL, aislamiento
```

## Pendiente

- Miniaturas y transcodificación (cola `media`, background).
- CORS del bucket para el origen de `apps/web`.
- Borrado por prefijo del inquilino (retención, P-07).
