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

## Enviar archivos de verdad (PR-54, 2026-09-16)

El usuario lo dijo en una frase: «no permite ni vídeo ni enviar varias fotos a la vez». Detrás había **tres cosas distintas**, y dos eran fallos míos.

### 1. `limitesDeMedios` era una promesa que nadie cumplía

El contrato de canales declara el tamaño máximo por tipo desde PR-7, y `validarContraCapacidades` sabe comprobarlo. Pero la puerta de envío validaba capacidades en el paso 5 —**antes** de cargar el medio— y nunca le pasaba `bytes`. Resultado: un vídeo de 38 MB se subía entero al almacén, se encolaba, salía hacia Meta y fallaba allí con un error que no dice cuánto pesa ni cuánto cabe.

Ahora se comprueba en el paso 5b, donde ya se conoce el tamaño, y el envío muere con un 422 que dice las dos cifras. El precio: una comprobación más en el camino caliente, sobre datos que ya estaban en la misma fila.

### 2. El filtro del selector escondía los vídeos

`accept="video/mp4"` hacía que un vídeo del iPhone —`video/quicktime`— apareciera **en gris**, sin explicación. Parecía que el CRM no admitía vídeo. Ahora se acepta `video/*` y la ficha dice qué pasa: «WhatsApp solo admite vídeo MP4. Conviértelo antes de enviarlo». Un motivo se puede resolver; un archivo en gris, no.

### 3. Elegir un archivo lo enviaba

No había forma de ver qué se había cogido, de quitarlo, ni de mandar tres fotos sin repetir el gesto tres veces. **Y enviar una foto equivocada a un cliente no se deshace.**

La bandeja de adjuntos (`Adjuntos.tsx`) enseña miniatura, nombre y peso, deja quitar uno y envía al pulsar. Decisiones:

- **Varios archivos, un mensaje cada uno.** WhatsApp Cloud API no tiene álbumes: tres fotos son tres mensajes. Fingir un álbum mentiría sobre lo que ve el cliente.
- **De uno en uno, no en paralelo.** El orden en que los ve el cliente es el orden en que se eligieron, y tres subidas a la vez por una red móvil tardan más que tres seguidas.
- **El pie va solo en el primero**, como hace WhatsApp con una tanda.
- **Si uno falla a mitad, los que salieron no se deshacen** —un mensaje enviado no se retira— y los que faltan se quedan en la bandeja con el error, para reintentar solo esos.
- **El vídeo se previsualiza con su primer fotograma**, no con un icono: hay que ver QUÉ vídeo se manda, que es todo el punto.

### 4. Avisar antes de subir: `GET /v1/medios/limites`

Sale de la lista de MIME del servidor y de las capacidades que declara cada adaptador —no hay una segunda lista que mantener—. La web lo usa para marcar en rojo el archivo que no cabe **antes** de gastar la subida. El servidor lo sigue comprobando al enviar: la puerta es la que manda.

### Cómo comprobarlo en menos de 5 minutos

1. Abrir una conversación, pulsar el clip y elegir **tres fotos a la vez**: aparecen las tres con miniatura.
2. Quitar una con la ×. Escribir un pie. Pulsar «Enviar 2».
3. Llegan dos mensajes al WhatsApp del cliente, en orden, y solo el primero con pie.
4. Elegir un vídeo de más de 16 MB: se marca en rojo con el peso y el máximo, y «Enviar» no lo deja pasar.

Cubierto por 5 tests de la bandeja (`Compositor.test.tsx`) y 4 de servidor (`medios.e2e.test.ts`), incluido el del vídeo de 30 MB que no llega a encolarse.
