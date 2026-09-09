---
estado: aceptado
fecha: 2026-09-09
modulo: medios
tags: [adr, medios, s3, seguridad]
---

# ADR-009 — Medios: nada público, URL firmadas y subida directa desde el navegador

## Contexto

WhatsApp entrega los medios entrantes como un `media_id` cuya URL firmada caduca en minutos. Los salientes se envían por URL que Meta descarga. Y la bandeja tiene que mostrar imágenes y reproducir audios sin convertirse en un proxy de bytes. Tres flujos, un almacén (MinIO en desarrollo, R2 en producción, ambos por la API de S3).

## Decisión

1. **Descarga inmediata por job propio.** Al persistir un entrante con `mediaId`, el worker crea el `media_asset` en `pending` en la misma transacción y publica `media.descargar` por el outbox. Un consumidor de la cola `media` descarga con `fetchMedia` y guarda. Esperar a que alguien abra la conversación es perder el archivo.
2. **Nada es público.** El bucket no tiene lectura anónima (se quitó `mc anonymous set download` del compose). Toda lectura es una URL firmada de 5 minutos que pide el navegador a `GET /v1/medios/:id/url`; RLS decide si el medio es tuyo antes de firmar. Para enviar, la URL se firma **en el worker en el momento del envío** (1 hora), no en la API al encolar: un job que espere más que el TTL fallaría con una URL caducada.
3. **Subida directa desde el navegador.** `POST /v1/medios/subidas` crea el `media_asset` y devuelve una URL firmada de `PUT`; el navegador sube al almacén sin pasar por la API; `POST /v1/medios/subidas/:id/confirmar` comprueba que el objeto existe y marca `stored`. La API nunca toca los bytes.
4. **Claves por inquilino** (`tenants/<id>/media/<asset>.<ext>`), extensión derivada del MIME y no del nombre del proveedor. Deduplicación por `sha256` **dentro del inquilino**: el mismo catálogo a 500 contactos se guarda una vez; entre inquilinos nunca se comparte clave, porque el borrado por prefijo de uno no puede romper al otro.

## Costo de lo elegido

- Dos viajes para ver una imagen (pedir URL, luego el objeto). Se mitiga cacheando la URL 4 minutos en el cliente.
- Una URL firmada es pública mientras dura. Quien la tenga en esos 5 minutos puede leer el objeto. Aceptado: es el mismo modelo de Meta y de todo CRM que conozco.
- La subida directa exige CORS en el bucket para el origen de la web (pendiente al llegar a `apps/web`).
- Sin miniaturas ni transcodificación todavía: el navegador escala la imagen original. Costará ancho de banda en listas largas; va en background cuando duela.

## Dónde habría ganado la alternativa

- **Proxy por la API** (`GET /v1/medios/:id` devolviendo bytes): un solo viaje y control total de cabeceras. Habría ganado con muy pocos usuarios y sin CDN. Pierde porque cada imagen ocupa un worker de Node el tiempo de la transferencia y sería el primer cuello de botella del producto.
- **Bucket público con claves impredecibles**: cero lógica de firma. Pierde porque una URL filtrada en un log o un chat es permanente; con firma caduca sola.
- **Enviar medios por bytes** (subir a `/media` de Meta y mandar el `id`) en vez de por URL firmada: evita exponer nada. Se mantiene como opción del adaptador (`origen: buffer`) para cuando Meta rechace una URL; por defecto URL porque no obliga al worker a cargar el archivo en memoria.

## Consecuencias

- `@aws-sdk/client-s3` y `@aws-sdk/s3-request-presigner` entran como dependencias. No son «dependencia pesada» en el sentido de la lista de parada: el almacenamiento S3 ya estaba en la tabla de stack y R2 no añade coste recurrente hasta que haya volumen.
- Solo `packages/storage` habla con MinIO en tests; API y worker usan `AlmacenEnMemoria`. La CI levanta MinIO únicamente para ese paquete.
