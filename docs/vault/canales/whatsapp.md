---
estado: vivo
fecha: 2026-09-07
modulo: canales
tags: [canal, whatsapp, meta, mvp, restricciones-externas]
---

# Canal — WhatsApp Cloud API

Canal del MVP. Fase 1.

> Esta nota recoge **restricciones que impone Meta**, no cómo está implementado el adaptador. Lo segundo se lee en el código; lo primero cuesta semanas descubrirlo.

## Restricciones que condicionan el diseño

- **Ventana de 24 horas.** Fuera de ella solo se pueden enviar plantillas aprobadas. La ventana se reinicia con cada mensaje **entrante** del usuario, no con los salientes. Se calcula y se aplica **en servidor** (columna `session_expires_at` de `conversations`); el frontend solo la pinta.
- **Meta factura por mensaje entregado desde el 1 de julio de 2025**, no por conversación. Antes de esa fecha el modelo era por conversación de 24 h; toda documentación anterior que hable de "conversaciones facturables" está obsoleta.
- **Qué se cobra y qué no** (verificado en la documentación de Meta, 2026-09-07):
  - *Marketing*: siempre se cobra.
  - *Utility*: **gratis** si se entrega dentro de una ventana de servicio abierta; se cobra fuera de ella.
  - *Authentication*: se cobra fuera de la ventana. Kommo directamente no la soporta.
  - *Service* y todo mensaje libre no-plantilla: **gratis**, pero solo dentro de la ventana abierta.
  - Entrada gratuita: 72 h de mensajes gratis si el contacto llega por anuncio Click-to-WhatsApp o botón de página.
- **Consecuencia de producto:** el CRM puede decir al usuario, antes de enviar, si ese mensaje le va a costar dinero. Es una función real, no un detalle contable.
- **Tarifa por país** (código de país del destinatario) **y por categoría**, con descuentos por volumen mensual que se calculan por país y por categoría, y se reinician cada mes.
- **Quién recibe la factura: el titular de la WABA.** Es el hecho que decide P-01 y P-02.
- **La categoría efectiva la decide Meta**, y puede diferir de la que declara el usuario. Por eso el esquema guarda `category_declared` y `category_effective` por separado: la segunda es la que determina el costo.
- **Una plantilla aprobada puede pausarse o deshabilitarse después** si los usuarios la reportan. El CRM tiene que enterarse por webhook y avisar. Una plantilla no es una constante, es estado sincronizado.
- **Calidad del número y límite de envío** cambian solos, de un día para otro, según el comportamiento de los destinatarios. Un cliente puede pasar de 10.000 a 1.000 destinatarios diarios sin haber hecho nada distinto.
- **La URL de medios entrantes es firmada y de vida corta.** Meta entrega un `media_id`; hay que descargar a almacenamiento propio inmediatamente, no guardar la URL. La columna `remote_expires_at` existe para hacer visible esa caducidad.
- **Meta reenvía eventos.** El webhook debe ser idempotente por `(channel_account_id, external_message_id)`. Ver [[ADR-006-particionado-idempotencia]] (pendiente).

## Causas frecuentes de rechazo de plantilla

El editor **advierte**, no bloquea: la decisión es de Meta y equivocarse advirtiendo de más es peor que dejar intentarlo.

- Contenido promocional declarado como `utility`.
- Enlaces acortados (bit.ly y similares).
- Variables al principio o al final del cuerpo, sin texto que las envuelva.
- Variables sin ejemplo. Meta rechaza plantillas sin muestra, y esto es rechazo seguro, no probable.
- Promesas engañosas, garantías absolutas, contenido de categorías prohibidas.

Cuando llega un rechazo, **el motivo viene en el webhook y hay que guardarlo y mostrarlo**: es lo único que permite corregir. Perder el motivo obliga al cliente a adivinar.

## El riesgo principal del proyecto vive aquí

Antes del primer mensaje real hacen falta verificación de empresa, App Review y un número con calidad aceptable. Ninguno de esos plazos los controlamos ni los podemos comprometer ante un cliente.

**Mitigación, de fase 0 y no posterior:** el adaptador tiene modo *sandbox* que simula respuestas del proveedor, para que ninguna fase de desarrollo dependa de tener credenciales reales. Todo lo que Meta puede cambiar —estado de plantilla, categoría efectiva, calidad, límite de envío— se modela como estado sincronizado por webhook, nunca como constante en código.

## Decisión pendiente que bloquea el diseño

**P-01: modelo de despliegue.** Sin cerrar a fecha 2026-09-07.

| Modelo | A favor | En contra |
|---|---|---|
| **Tech Provider propio** (Embedded Signup) | Cada cliente conecta su WABA y paga a Meta directo. Sin riesgo financiero ni de calidad para nosotros. | Exige nuestra Business Verification y App Review. Semanas antes de vender. |
| **Vía BSP** (360dialog, Twilio…) | Se arranca en días. | El costo por mensaje pasa por nosotros, con markup del BSP encima. Obliga a resolver P-02 antes de cobrar. |
| **WABA compartida nuestra** | Lo más rápido. | Lo más frágil: la calidad de un cliente degrada el número de todos, y Meta lo penaliza como spam. **No recomendado.** |

## Aprendizajes de terceros — Kommo

Investigado el 2026-09-07 sobre documentación pública de Kommo. No es experiencia propia, pero es la evidencia más barata que vamos a conseguir.

- **Kommo es Tech Partner de Meta**: conexión directa a Cloud API, el cliente crea su propio Meta Business Portfolio y su WABA por Embedded Signup, y **añade su método de pago a su propia cuenta**. Kommo no factura el consumo de Meta.
- **Kommo probó el modelo contrario y lo abandonó.** Su producto anterior, "WhatsApp Business API", funcionaba con **saldo prepago recargable**. Cortó las recargas el **2024-09-20** y dejó de mantenerlo el **2024-10-01**, migrando a la conexión directa.
- **Lo que costó esa migración**, en sus propias palabras: *"las automatizaciones (bots y triggers) se reinician durante la migración y hay que reconfigurarlas"*. El historial de conversaciones sí se conservó. **Traducción para nosotros: cambiar de modelo de conexión rompe los Salesbots de los clientes.** Es el dato duro del criterio de reversión en [[ADR-004-modelo-whatsapp]].
- **Techos de números por portafolio**: sin verificar, 2 números; verificado, sube a 20. La verificación no es opcional en la práctica.
- **Un número solo puede conectarse a una cuenta de Kommo.** Restricción sensata que conviene copiar: evita estados ambiguos.
- **Límite inicial de 250 conversaciones diarias** por número nuevo, que sube a 1.000 tras verificar el portafolio.
- **Estructura comercial de Kommo**, como referencia para el módulo de facturación: suscripción **por asiento** ($25 / $35 / $45 por usuario/mes, mínimo 6 meses), y **la IA como único consumo medido**, con packs de recarga de créditos. Contactos, leads y campos personalizados son límites de plan, no consumo facturado. Coherente: la IA es lo único donde ellos también le pagan a un proveedor.

## Códigos de error de Cloud API que decide el adaptador

Tomados de la documentación y codificados en `AdaptadorWhatsapp`. Lo importante es `reintentable`:

| Código | Significado | Reintentable |
|---|---|---|
| 190 / HTTP 401 | Token inválido o caducado | No |
| 4, 80007, 130429, 131056, HTTP 429 | Límite de tasa | Sí, respeta `Retry-After` |
| 131047 | Fuera de la ventana de 24 h | No — hay que usar plantilla |
| 131021, 131026, 131030 | Destinatario inválido o no alcanzable | No |
| 132000–132015 | Plantilla no aprobada / parámetros | No |
| 131052, 131053 | Medio inválido o demasiado grande | No |
| 1, 2, 131000, 131016, HTTP 5xx | Fallo temporal de Meta | Sí |

## Conexión BYO: qué hay que sacar del panel de Meta

Para `POST /v1/canales/whatsapp` hacen falta cuatro datos, todos en *WhatsApp → Configuración de la API* de la app en developers.facebook.com: **phone_number_id**, **id de la WABA**, **token** (el temporal caduca a las 24 h; para uno estable, *system user* en Business Manager) y el **app secret** (en *Configuración → Básica*). El webhook se registra con la URL pública `/webhooks/whatsapp` y el `verify_token` que elijamos.

**Para desarrollar no hace falta comprar número:** Meta da un número de prueba gratuito que envía a hasta 5 destinatarios verificados. El móvil personal del usuario sirve como destinatario. **El número de producción de Nippon no se toca hasta el final**: está en uso en Kommo.

## Aprendizajes propios verificados

Ninguno todavía. Esta sección se llena cuando toquemos la API de verdad, y es la parte de esta nota que más va a valer dentro de tres meses.


## Aprendizajes con tráfico REAL (2026-09-09)

Primera conversación real de punta a punta con el número de prueba de Meta. Lo que costó horas y no está en el flujo guiado del panel:

### 1. Configurar el webhook NO basta: hay que suscribir la WABA a tu app

El panel te lleva a poner URL y token de verificación en la app, y el reto responde 200. Pero los mensajes siguen sin llegar. El motivo: la **WABA** tiene su propia lista de apps suscritas, y la del número de prueba viene suscrita a **`WA DevX Webhook Events 1P App`** (id `2202427980234937`), la app interna del panel de Meta. Mientras esa sea la única, los webhooks se los queda ella.

```
GET  /{waba-id}/subscribed_apps    → ver quién recibe
POST /{waba-id}/subscribed_apps    → suscribir la tuya (el token decide cuál es "la tuya")
DELETE /{waba-id}/subscribed_apps  → revertir
```

**Consecuencia de producto:** el alta BYO debe hacer este POST, o el cliente conectará su número y no recibirá nada sin saber por qué. Es trabajo pendiente en `conectarWhatsapp`.

### 2. El botón «Probar» del panel manda identificadores ficticios

Envía `entry[].id = "0"`, `phone_number_id = "123456123"`, número `16505551111`. No resuelve a ninguna cuenta nuestra, así que no hay app secret con el que verificar la firma → `signature_ok: false` y 401. **Es el comportamiento correcto**, pero parece un fallo: al depurar, mirar `phone_number_id` antes de sospechar de la firma.

### 3. Que Meta te envíe un mensaje no genera webhook entrante

El «hello_world» del panel va del número de prueba al móvil. El webhook entrante lo genera **la respuesta desde el móvil**.

### 4. El token temporal del panel caduca en 24 h

Y cuando lo hace, Graph responde `code: 190, error_subcode: 463` con «Session has expired». Recibir sigue funcionando (la firma usa el app secret, que no caduca); **enviar, no**. De aquí sale `PATCH /v1/canales/:id/credenciales`. Lo permanente sale de un usuario del sistema en Business Manager con `whatsapp_business_messaging` y `whatsapp_business_management`.

### 5. `profile.name` puede ser cualquier cosa

El contacto real llegó con nombre `.` porque así se llama el perfil de WhatsApp. Guardamos ese valor en `contact_identities.handle`, y la bandeja lo pinta. Para WhatsApp el `handle` debería ser el teléfono (`phone_e164`), que sí es útil. Pendiente.

### Evidencia

Entrante: `wamid.HBgLNTE5MjUzMDAyMjQ…`, texto «Respuesta», firma verificada, ventana calculada a 24 h, uso medido. Saliente desde el CRM: `delivered` confirmado por Meta con su propio `wamid`. Los dos sentidos, con el mismo código que corre en los tests.
