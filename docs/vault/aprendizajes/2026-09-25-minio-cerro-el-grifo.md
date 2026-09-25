---
estado: vivo
fecha: 2026-09-25
modulo: infra
tags: [aprendizaje, ci, almacenamiento]
---

# Fijar la versión no protege de que cierren el grifo

Tres veces en tres semanas, el mismo paso del CI roto por la misma causa: la
imagen de MinIO deja de poder descargarse.

| Cuándo | Qué pasó | Qué se hizo |
| --- | --- | --- |
| Antes de 09-16 | `bitnami/minio` deja de publicarse en Docker Hub | Se pasa a `minio/minio` |
| 09-16 | `minio/minio` de Docker Hub: «repository does not exist». **30 ejecuciones rojas seguidas** | Se pasa a `quay.io/minio/minio`, **con la versión fijada** |
| 09-25 | Esa misma etiqueta fijada contesta `unauthorized` | Se sale de MinIO |

## Lo que me enseñó, que no es lo que creía

Después del segundo golpe escribí en el workflow que las imágenes iban
**pinchadas a una versión** «porque una etiqueta móvil es exactamente como se
rompió esto». Era verdad y no bastaba.

Fijar la versión protege de que **el contenido** de una etiqueta cambie bajo
tus pies. No protege de que el dueño **retire el permiso de leerla**. La
etiqueta seguía existiendo; lo que desapareció fue el acceso anónimo:

```
$ docker pull quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z.hotfix.7aa24e772
Error response from daemon: unauthorized: access to the requested resource is not authorized
```

Son dos riesgos distintos y yo estaba cubriendo solo uno. La señal que ignoré
es que MinIO llevaba **dos movimientos seguidos** cerrando el acceso a su
edición comunitaria. La tercera vez no era mala suerte: era la tendencia.

## La decisión

`adobe/s3mock:4.7.0`. Apache-2.0, pública en Docker Hub, hecha para esto.

Lo que había que comprobar antes de moverse no es que «sea S3», sino que haga
**lo único que ese test pide**: que una URL firmada de lectura y una de subida
funcionen contra un servidor de verdad. Se probó antes de tocar nada, y los
seis tests pasan sin cambiar una línea del test.

De paso arranca en segundos y no necesita un segundo contenedor con `mc` para
crear el bucket: `initialBuckets` lo hace al levantar.

## Lo que cuesta

La consola web de MinIO en `:9001`, que servía para mirar a ojo los archivos
subidos en desarrollo. No la usaba ningún test y en CI no la mira nadie, pero
en local se echa de menos el día que algo no aparece donde debería.

## Por qué cambió también el compose de desarrollo

Se podía haber dejado MinIO en local —la imagen ya estaba en caché de esta
máquina, funcionando— y cambiar solo el CI. Habría sido menos trabajo hoy.

Pero eso es precisamente lo que ya hizo daño en septiembre: el compose local
siguió arrancando semanas **solo porque la imagen estaba cacheada aquí**,
mientras en una máquina nueva no arrancaba. Una diferencia entre local y CI no
se nota hasta que el CI se pone rojo y en tu máquina funciona, y entonces
cuesta el doble.

Misma imagen en los dos sitios, y el puerto de fuera sigue siendo `9000`: ni
`.env` ni los tests cambian.
