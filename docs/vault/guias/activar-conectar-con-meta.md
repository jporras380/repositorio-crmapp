---
estado: vivo
fecha: 2026-10-10
modulo: canales
tags: [guia, meta, whatsapp, tech-provider, tramites]
---

# Activar «Conectar con Meta» y el QR de WhatsApp

Para quién: el dueño de la plataforma. Esto es lo que hay que tramitar **en Meta** para que el botón «Conectar con Meta» funcione con clientes reales. El código ya está hecho; sin estos pasos el botón no aparece y los canales se siguen conectando pegando credenciales, como hasta ahora.

Decisión y detalles técnicos: [[ADR-015-conectar-con-la-plataforma]].

## Antes de empezar

- **El CRM tiene que estar publicado en internet con HTTPS.** Meta solo acepta dominios `https://` para abrir su ventana y para enviar los avisos (webhooks). En tu computadora no funciona.
- Tiempo: la revisión de Meta suele tardar **semanas**, y no depende de nosotros.

## Lo que hay que conseguir

| Qué | Dónde | Para qué |
|---|---|---|
| Empresa **verificada** | Meta Business Suite → Configuración → Centro de seguridad | Sin esto Meta no revisa la app |
| Una **app de Meta** con el producto WhatsApp | developers.facebook.com | Es «la app de la plataforma» |
| Ser **Tech Provider** | Panel de la app → WhatsApp | Poder conectar números de otros negocios |
| **Acceso avanzado** a `whatsapp_business_messaging` y `whatsapp_business_management` | Panel de la app → Revisión de la app | Con acceso estándar el botón te funciona a ti y **falla a todos tus clientes** |
| Acceso avanzado a los permisos de páginas e Instagram | Igual | Para «Conectar con Facebook» |

Los nombres de los menús de Meta cambian a menudo: lo que importa es la columna «Qué», no la ruta exacta.

Los permisos de páginas e Instagram que usa el CRM hoy: `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_manage_engagement`, `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`.

## Lo que hay que configurar en la app

1. **Inicio de sesión con Facebook para empresas → Configuraciones.** Crear dos:
   - Una de **WhatsApp Embedded Signup**, versión **v4** (las v2 y v3 se retiran el 15 de octubre de 2026). Activos: solo cuentas de WhatsApp Business y números.
   - Una para **páginas de Facebook e Instagram**.

   Cada una da un **identificador de configuración**.
2. **Dominios permitidos y URI de redirección:** el dominio HTTPS del CRM.
3. **Webhooks de WhatsApp**, apuntando a `https://<tu-dominio>/webhooks/whatsapp`, suscritos a estos campos:
   - `messages` — mensajes y estados (ya se usa hoy)
   - `message_template_status_update` — plantillas (ya se usa hoy)
   - `smb_message_echoes` — lo que el hotel responde desde el celular
   - `history` — los chats antiguos
   - `smb_app_state_sync` — la agenda del celular

   Sin los tres últimos, la coexistencia conecta pero el CRM enseña media conversación.

## Lo que hay que poner en el servidor

Cuatro variables, en el `.env` de producción. **No me las pegues en el chat**: son las llaves de la app.

```
META_APP_ID=                 # id de la app
META_APP_SECRET=             # clave secreta de la app
META_CONFIG_ID_WHATSAPP=     # la configuración de Embedded Signup
META_CONFIG_ID_PAGINAS=      # la de páginas e Instagram
```

Con `META_APP_ID` y `META_APP_SECRET` aparece el botón. Cada `CONFIG_ID` enciende su canal: se puede activar WhatsApp antes que páginas, o al revés.

## Cómo comprobarlo

1. Entrar al CRM → Ajustes → Canales → «Conectar WhatsApp». Debe salir «Conectar con Meta» en vez del formulario de token.
2. **Probar primero con un número que no sea el de un hotel.** Nada de esto se ha probado contra Meta de verdad: la primera conexión puede traer sorpresas.
3. Probar con una cuenta de Facebook que **no** tenga ningún rol en la app. Es la única forma de ver lo que verá un cliente.

## Lo que hay que decirle a cada hotel antes de conectar por QR

La pantalla ya lo dice, pero conviene que lo sepa de antemano:

- Tiene que abrir la app WhatsApp Business del celular **al menos una vez cada 14 días**, o la conexión se corta.
- En el celular dejan de funcionar las **listas de difusión**, los mensajes temporales y los de ver una sola vez.
- Meta **avisa a sus clientes** de que sus chats pasan por un servicio de Meta.
- Si acepta compartir los chats, se traen sus contactos y hasta **6 meses** de conversaciones. Los grupos y los archivados no vienen, y las fotos antiguas llegan sin el archivo.
- Lo que envíe desde el CRM se cobra según las tarifas de Meta; lo que envíe desde el celular sigue siendo gratis.
