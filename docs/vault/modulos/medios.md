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

## Las imágenes salían y no llegaban (PR-57, 2026-09-16)

El usuario mandó cuatro fotos y un texto desde la bandeja. Llegó **solo el texto**. En la base de datos las cuatro imágenes estaban en `sent`, con su `wamid` de Meta y **sin error**: para el CRM se habían enviado.

### La causa

El worker mandaba **siempre** una URL firmada del almacén, aunque el canal declarase que no la necesita. En desarrollo esa URL es `http://localhost:9000/...` (MinIO), y **los servidores de Meta no pueden entrar en el ordenador de nadie**. Meta acepta la llamada, devuelve un `wamid`, y falla *después*, al ir a descargar el archivo: `131053 Media upload error`. Ese fallo llega por webhook, que es justo lo que estaba caído (abajo), así que los mensajes se quedaron en «Enviado» para siempre.

Una imagen anterior, del mismo día a las 17:36, **sí tiene registrado ese error**: es la misma causa con el webhook todavía vivo.

### El arreglo

`requiereUrlPublicaParaMedios` está en el contrato desde PR-7 —WhatsApp `false`, Instagram y Facebook `true`— y **no lo miraba nadie**. Es el mismo tipo de fallo que `limitesDeMedios` en PR-54: una capacidad declarada que no se usaba.

Ahora el worker decide por capacidad:

- **WhatsApp**: se leen los bytes del almacén y se suben a Meta (`POST /{phone_number_id}/media`), que devuelve un id. **El almacén no tiene que ser accesible desde internet**, ni en desarrollo ni en producción.
- **Instagram y Facebook**: siguen recibiendo una URL firmada, porque descargan el medio ellos. Ahí no hay alternativa — y por eso la decisión es por capacidad del canal y no un `if` por nombre.

Hizo falta `Almacen.leer()`, que no existía.

**El precio, dicho:** subir por bytes son dos viajes en vez de uno, y el archivo entero pasa por la memoria del worker. Con el tope de 100 MB por documento y el semáforo de concurrencia por inquilino es asumible; si algún día se nota, la salida es enviar en flujo en lugar de en un buffer.

### Lo que este arreglo NO cubre

**Instagram y Facebook siguen sin poder enviar medios en desarrollo**, porque necesitan una URL pública de verdad y MinIO es local. Para probarlos hace falta exponer el bucket o usar un S3 real.

### Deuda que salió mirando esto

El nombre del archivo no viaja: un PDF llega al cliente como «archivo». `prepararSubida` ya recibe el nombre; falta guardarlo y pasarlo como `filename`.

### Cómo comprobarlo en menos de 5 minutos

1. Levantar túnel, API, worker y web, y **actualizar la URL del webhook en Meta** (ver abajo).
2. Mandar dos fotos desde la bandeja.
3. Llegan al WhatsApp del cliente, y en el hilo pasan de «Enviado» a «Entregado» y «Leído».

## Por qué «no llega nada a la bandeja»: el túnel

Comprobado el 16/09/2026: el último webhook recibido fue a las **17:36:52**, y los mensajes de las 20:39 y 20:40 no tienen estado de entrega. `cloudflared` estaba **vivo pero recién arrancado** (8 peticiones servidas en total), es decir, **con una URL nueva que Meta no conocía**.

Es el primero de los tres motivos de [[whatsapp]] §Aprendizajes con tráfico REAL, y se repite en cada reinicio porque un túnel rápido de Cloudflare cambia de URL cada vez. Mientras no haya un túnel con nombre fijo, después de cada reinicio hay que:

1. Mirar la ventana de `cloudflared` y copiar la URL `https://…trycloudflare.com`.
2. Pegarla en Meta → WhatsApp → Configuración → Webhook, con el mismo token de verificación.
3. Comprobar que entra algo: escribir al número y ver el mensaje en la bandeja.

**Síntoma que lo delata sin mirar nada más:** los mensajes que salen se quedan en «Enviado» y nunca pasan a «Entregado».

### Comprobado con tráfico real (16/09/2026, 20:56)

Se leyó del almacén una imagen de **1 097 KB**, se subió a Meta por bytes y se envió al número de pruebas. Los webhooks la marcaron **`sent` → `delivered` → `read`**, y el usuario confirmó haberla recibido. Es la misma imagen que minutos antes había fallado cinco veces con `131053` por el camino de la URL.

El guion de comprobación se borró después: mandaba mensajes de verdad y no tiene sitio en `src/`.
