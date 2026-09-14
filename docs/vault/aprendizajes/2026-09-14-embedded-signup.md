---
estado: vivo
fecha: 2026-09-14
modulo: canales
tags: [whatsapp, meta, embedded-signup, p-26, plan]
---

# Embedded Signup (P-26, opción B) — qué hace falta y en qué orden

El botón «Conectar número» de Kommo es el **Embedded Signup** de Meta: una ventana de Facebook donde el dueño elige su negocio y su número, y el CRM recibe un código que cambia por un token. Con el mismo flujo se puede conectar un número que ya usa la **app WhatsApp Business** del móvil, sin dejar de usarla («coexistencia»).

## Lo que ya se sabe de los CRM de referencia (leído en su código, 2026-09-14)

- **wacrm** no lo tiene: pide `phone_number_id` + token. Solo menciona Embedded Signup como la app que registró el número *antes*, que le robaba los webhooks.
- **vocero-crm** tampoco: su asistente dice «tu agencia hace el Embedded Signup en SU plataforma… te entrega el token para pegarlo aquí». Lo útil es su skill `whatsapp-meta-app-review` (guion de vídeo y textos de revisión) y `whatsapp-saas-meta-infra`.

Ninguno ahorra el trabajo: **lo que frena no es el código, son los requisitos de Meta.**

## Orden

1. **Usuario:** Meta Business verificada a nombre de la empresa que vende el CRM (RUC, dominio, documentos).
2. **Usuario:** dominio público con política de privacidad y URL de borrado de datos.
3. **Nosotros:** app de Meta propia del SaaS, Facebook Login for Business y configuración de Embedded Signup (`config_id`).
4. **Nosotros:** código — botón con el SDK de Facebook, endpoint que cambia el código por token de negocio, suscripción de la WABA y registro del número. El descubrimiento de PR-39 (`debug_token` → `granular_scopes`) **se reutiliza tal cual**: es exactamente lo que Meta indica hacer tras el alta.
5. **Juntos:** App Review de `whatsapp_business_management` y `whatsapp_business_messaging`, con vídeo del flujo completo. Suele rechazarse a la primera; semanas.
6. **ADR nuevo** que sustituya a [[ADR-004-modelo-whatsapp]] en lo que toque: con Embedded Signup somos responsables ante Meta del acceso a las cuentas de los clientes.

Hasta el paso 5, el botón solo funciona con cuentas que tengan rol en nuestra app. La opción A queda como camino alternativo aunque B salga: un cliente con su propia app sigue pudiendo pegar su token.

Enlaces: [[02-PREGUNTAS-ABIERTAS]] §P-26, [[whatsapp]], [[instagram]].
