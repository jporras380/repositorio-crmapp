---
estado: aceptado
fecha: 2026-10-10
modulo: canales
tags: [adr, canales, meta, whatsapp, coexistencia, embedded-signup, tech-provider]
---

# ADR-015 — Conectar con la app de Meta de la plataforma, sin quitar la del cliente

## Contexto

ADR-004 eligió «BYO»: cada hotel trae su propia app de Meta y pega su token y su clave secreta. Funciona y no depende de nadie, pero pide a un hotelero que cree una app de desarrollador.

El dueño pidió conectar **por QR**, como Kommo. Lo que existe de verdad, comprobado en la documentación de Meta:

| Canal | Forma oficial | ¿QR? |
|---|---|---|
| WhatsApp | *Embedded Signup* con **coexistencia**: el hotel sigue usando la app WhatsApp Business del celular y conecta el mismo número escaneando un QR desde ella | Sí |
| Instagram / Facebook | Inicio de sesión de Facebook para empresas | No: es un inicio de sesión |
| TikTok | Inicio de sesión de TikTok (su página ofrece QR) | Lo pone TikTok |

Las tres exigen que **la plataforma** tenga una app aprobada: en Meta, ser *Tech Provider* con acceso avanzado a `whatsapp_business_messaging` y `whatsapp_business_management`.

## Opciones

| | Qué era | Por qué no / por qué sí |
|---|---|---|
| A. Seguir solo con BYO | No tocar nada | No hay QR. El dueño lo pidió expresamente |
| B. Librería no oficial (tipo WhatsApp Web) | QR hoy, sin trámites | Viola las condiciones de WhatsApp: bloqueo **permanente** del número del hotel. Descartada por el dueño |
| C. Sustituir BYO por la app de la plataforma | Un solo camino | Deja el producto parado hasta que Meta apruebe, y sin salida para quien ya tiene su app |
| **D. Las dos, conviviendo** | Botón si la plataforma está configurada; pegar credenciales si no, o si el cliente lo prefiere | Nada se rompe hoy, y el día que Meta apruebe solo hay que poner cuatro variables |

## Decisión

**D.** `connected_via` en `channel_accounts` dice cuál fue (`credenciales` o `plataforma`). No sustituye a ADR-004.

### Cómo viaja el token

La ventana de Meta devuelve un **código** de un solo uso. El servidor lo cambia por un token y devuelve la lista de cuentas y una **credencial sellada**: el token cifrado con la clave maestra, atado a la cuenta que lo pidió, con 15 minutos de vida. El navegador guarda un sobre que no puede abrir ni usar en otra cuenta. Sin tabla de sesiones a medio conectar.

El cupo del plan se mira **antes** de gastar el código: vale una vez, y gastarlo para decir «no cabe» obligaría a repetir el QR.

### La clave secreta de la app

Un canal conectado con la plataforma guarda **una copia cifrada de la clave secreta de la app de la plataforma** como su `app_secret`. Así la verificación de webhooks y los resolvedores no cambian: siguen leyendo la clave de la cuenta.

**Coste:** si se rota la clave de la app en Meta, hay que reescribirla en todas las cuentas `plataforma`. Para eso existe la columna. No hay script todavía: se escribe el día que haga falta.

### Coexistencia

Se le pregunta **a Meta**, no al navegador, si el número sigue en la app del celular (`is_on_biz_app`):

- **Sí:** no se registra —registrarlo lo sacaría de la app—, y se piden la agenda y los chats.
- **No** (número nuevo): se registra en la Cloud API con un PIN generado, que se guarda cifrado. Si Meta no lo acepta, el canal queda conectado y se dice.

### Ecos

Lo que el hotel responde desde el celular llega como `smb_message_echoes`. Se guarda como **saliente de una persona**, marcado «desde el celular». Aparta a los bots igual que una respuesta desde la bandeja, **no** toca la ventana de 24 h y **no** se mide como envío.

### Historial y agenda

- Los mensajes antiguos se guardan **con su fecha de verdad**. Para eso `messages` tiene particiones siete meses hacia atrás (0055); hasta entonces todo se guardaba con la fecha de recepción.
- Una conversación importada nace **cerrada**: seis meses de chats abiertos llenarían la bandeja de «nuevas». Cuando esa persona vuelve a escribir se reabre esa, con su historia. La excepción: si lo último fue de la persona y la ventana sigue abierta, queda abierta —alguien escribió anoche y nadie contestó—.
- La agenda del celular **no crea clientes**: trae a gente con la que el hotel nunca habló por aquí. Se guarda aparte (`channel_contact_names`) y solo nombra a quien tiene conversación. No pisa un nombre que haya puesto una persona.
- No abre leads, no reparte, no mide uso, no dispara bots.

### La guarda de arquitectura

ARCH §9 prohíbe insertar un saliente fuera de `packages/envio`. Ecos e historial son salientes que el CRM **no envía**. No se añadió una excepción: se creó en ese paquete una segunda puerta, `ajeno.ts`, que registra y no envía —no escribe `mensaje.enviar` en el outbox—. La regla sigue siendo verdad sin asteriscos.

## Lo que NO está probado

**Nada de esto ha hablado con Meta de verdad.** No hay app de Tech Provider aprobada. Los tests usan los cuerpos que publica la documentación de Meta y un cliente falso. La primera conexión real puede traer sorpresas —un campo que falta, un orden distinto—, y hay que hacerla con el número de prueba antes que con el de un hotel.

## Pendiente, sin fecha

- **Archivos del historial.** Meta manda los medios antiguos sin archivo, y aparte los de los últimos 14 días. Hoy se importa el mensaje con su tipo y su pie; la bandeja dice «el archivo no se importó».
- **Desconexión desde el celular.** Meta avisa con `account_update` / `PARTNER_REMOVED`. No se procesa: el canal seguiría figurando conectado hasta que alguien lo note por «sin eventos».
- **El historial se pide una sola vez**, en las 24 h siguientes a conectar. Quien conecte y Meta rechace la petición tiene que desconectar y volver a conectar para tenerlo.
- **Rotar la clave de la app** en las cuentas `plataforma`.
- **Embedded Signup v4.** Meta retira v2 y v3 el 15 de octubre de 2026. El código usa la forma de v4; la configuración del panel tiene que ser v4.

## Qué haría cambiar esta decisión

- Si Meta **rechaza** a la empresa como Tech Provider: se queda BYO, y el botón no aparece nunca. No hay que deshacer nada.
- Si mantener las dos formas da más soporte que valor: retirar el pegado de credenciales para cuentas nuevas, conservándolo en las que ya lo usan.
