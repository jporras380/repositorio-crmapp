---
estado: vivo
fecha: 2026-09-15
modulo: ia
tags: [ia, byok, anthropic, asistida, p-11]
---

# Módulo — IA asistida (BYOK)

Decisión del usuario ([[02-PREGUNTAS-ABIERTAS]] §P-11): **con la clave del propio hotel y solo asistida**. La IA redacta un borrador y una persona lo revisa y lo envía. Nunca contesta sola.

API en `apps/api/src/ia/`, ajustes en `apps/web/src/componentes/ajustes/Ia.tsx`, botón en el compositor.

![[2026-09-15-ia-ajustes.png]]

## Las tres reglas, y dónde se hacen cumplir

1. **Nunca envía.** `POST /v1/conversaciones/:id/sugerencia` devuelve texto y nada más; hay test que cuenta los mensajes antes y después. El envío es el de siempre, por la puerta de [[envio]], pulsado por un agente. Queda `sent_by = 'human'` (lo envió una persona) y `ai_generated = true` (lo redactó la IA). Las dos columnas existían desde la migración 0004, pensadas justo para esto. En el hilo se ve una marca «IA» en texto, no solo en color.
2. **Con la clave del hotel.** La IA empieza **apagada**: activarla hace que el contenido de las conversaciones salga hacia un tercero, y eso lo decide un administrador. La clave se guarda cifrada en `tenant_secrets` (migración 0025; tabla aparte porque `channel_secrets` cuelga de una cuenta de canal). **Se verifica con la Models API antes de guardarla**, que no consume tokens. Ninguna respuesta la devuelve. Borrar la clave apaga la IA.
3. **Solo lo que el agente ya puede ver.** La conversación se lee con `BandejaService.mensajes`, que aplica [[ADR-008-visibilidad-entre-agentes]]. Una conversación ajena da 404 sin llegar a llamar al proveedor.

## Qué ve la IA

- Los **30 mensajes más recientes**, en orden, como transcripción «Cliente / Hotel». Más contexto sale más caro para el hotel.
- El **catálogo**: tipos de habitación activos con capacidad y tarifa base, y los servicios adicionales.
- Las **instrucciones** que escribe el hotel: tono, horarios, políticas.
- Una regla explícita: **no inventar precios, descuentos, disponibilidad ni políticas**. Si falta un dato, responde que se confirma. La tarifa base es orientativa porque el precio real depende de las fechas ([[hotel]]).

## Proveedor

SDK oficial de Anthropic (`@anthropic-ai/sdk`), según la guía de la API de Claude: nada de `fetch` a mano en un proyecto TypeScript. Modelos ofrecidos: **Claude Opus 5** (por defecto), Sonnet 5 y Haiku 4.5.

- `effort: 'low'`: es un borrador de chat, no un razonamiento difícil. **Haiku 4.5 no acepta `effort`** (devuelve error), así que a ese modelo no se le manda.
- Con Opus 5 va el **respaldo de servidor ante negativas** (`fallbacks: 'default'`, beta `server-side-fallback-2026-07-01`): si el modelo declina, reintenta en otro dentro de la misma llamada. Si aun así declina, el agente ve «escríbela a mano».
- Errores traducidos a mensajes para personas: clave rechazada, sin permiso para el modelo, límite de la cuenta del hotel, proveedor caído.
- Cada sugerencia se mide como `ai.suggestions` en [[uso]]. **No se cobra**, porque la paga el hotel con su clave, pero sin el dato no se sabe si la función se usa.

Solo Anthropic por ahora. Otro proveedor sería otra implementación de `ClienteDeIa`, sin tocar el servicio.

## Pendiente

- **Probarlo con una clave real.** Todo está probado con un proveedor falso.
- Resumen de la conversación y clasificación automática del lead (del encargo §14), sobre la misma base.
- Cargar las tarifas por fecha y no solo la base, para que la IA pueda citar el precio de unas fechas concretas. Hoy lo evita a propósito.

## Cuatro proveedores, no uno (PR-86, 2026-09-21)

Hasta hoy la IA asistida era Claude y solo Claude. El usuario pidió poder elegir: Gemini —«la versión gratis o de pago»—, GPT y Grok.

Todos siguen siendo **BYOK** (P-11): el hotel pone su clave y paga su cuenta. El CRM no revende IA ni paga por ella, y eso no cambia con cuatro proveedores en vez de uno.

### El aviso que justifica la mitad del trabajo

**El plan gratuito de Gemini usa lo que se le manda para mejorar los modelos de Google.** Lo que se le manda aquí son conversaciones de huéspedes: su teléfono, sus fechas, a veces su tarjeta.

El aviso sale **antes** del campo de la clave y con `role="alert"`, no como pista gris al pie: se lee mientras se decide, no después de haber pegado la clave. Hay un test de API que comprueba que el texto viaja, y otro de pantalla que comprueba que se pinta al elegir Gemini y que no aparece para los de pago.

### Sin dependencias nuevas

Anthropic ya tenía su SDK y se queda. Los otros tres van con `fetch`: tres SDK oficiales serían tres dependencias grandes y tres formas de romperse, para usar de cada una **un solo endpoint**.

**OpenAI y xAI comparten implementación**: xAI publica su API como compatible con la de OpenAI, así que es el mismo código con otra URL. Si dejan de serlo, se parte en dos y el cambio queda encerrado en `clientes-http.ts`.

### Decisiones que se notan

- **El proveedor se guarda explícito** (migración 0038), no se deduce del nombre del modelo. Se podría —«gemini-…» delata a Google— y funcionaría hasta el primer modelo afinado que alguien llame `hotel-v2`.
- **Una clave por proveedor**, cada una en su `tenant_secrets.kind`. Probar Gemini y volver a Claude no obliga a ir a buscar la clave otra vez, y el desplegable dice cuáles ya la tienen.
- **El modelo es texto libre con sugerencias.** Los nombres cambian cada pocos meses; una lista cerrada obligaría a desplegar el CRM para usar el modelo que salió ayer. Al guardar, el proveedor confirma si existe, y un nombre inventado se rechaza ahí mismo.
- **Cambiar de proveedor cambia el modelo** al primero del nuevo. `claude-opus-5` no existe en Google: guardar esa pareja dejaría el botón roto hasta que alguien pidiera un borrador delante de un cliente.
- **Borrar una clave apaga la IA**, aunque sea la de otro proveedor. Es el gesto que se hace cuando una clave se filtró; dejarla encendida esperando a que el fallo salga solo sería peor.

### Lo que la reversa se lleva por delante

La migración `0038` amplía el `CHECK` de `tenant_secrets.kind`, que en 0025 solo conocía la clave de Anthropic. **Revertirla borra las claves de Google, OpenAI y xAI** —no hay dónde guardarlas mientras la restricción no las admita— y está escrito en el propio archivo de reversa.

### Dos cosas que encontraron los tests, no yo

1. El `CHECK` de `tenant_secrets` rechazaba `google_api_key`: el primer guardado dio 500. La restricción de 0025 era correcta el día que se escribió.
2. La guarda de deriva avisó de que había añadido `provider` a la base y no al esquema de Drizzle.

### Cómo comprobarlo en menos de 5 minutos

Ajustes → IA asistida. Cambia «Quién redacta» a Gemini: aparece el aviso del plan gratuito **antes** de pedir la clave, y el modelo salta a `gemini-2.5-pro`. Vuelve a Claude: si ya tenías su clave, el desplegable lo dice y no hace falta repegarla.

20 tests nuevos (10 de API, 10 de pantalla).
