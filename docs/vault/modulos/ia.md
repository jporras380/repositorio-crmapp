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
