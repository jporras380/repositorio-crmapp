---
estado: vivo
fecha: 2026-09-07
modulo: canales
tags: [canal, tiktok, fase-7, bloqueado-externamente]
---

# Canal — TikTok Business Messaging API

Fase 7. **Bloqueado por acceso, no por trabajo pendiente.**

## Restricción principal

El acceso a la API de mensajería está **restringido a socios aprobados**, o se llega vía un BSP. No es autoservicio como WhatsApp Cloud API. La solicitud es un proceso comercial con plazo desconocido y resultado no garantizado.

## Consecuencia de diseño, y es de fase 1 no de fase 7

**El adaptador se diseña ahora, no se implementa ahora, y el MVP no espera la aprobación.**

Es la razón concreta por la que la interfaz `ChannelAdapter` (`sendText`, `sendMedia`, `replyToComment`, `fetchMedia`, `syncTemplates`) tiene que estar cerrada antes de terminar WhatsApp: si el contrato se define con un solo canal implementado, se contamina con detalles de Meta y el tercer canal obliga a tocar el núcleo. Cambiar ese contrato después de implementar el primer canal está en la lista de parada de la sección 9 justamente por esto.

La prueba de que la abstracción es correcta llega en fase 2 con Instagram, no en fase 7 con TikTok. Si Instagram entra sin tocar el núcleo, TikTok también entrará.

## Qué hace falta averiguar cuando llegue el momento

- Si hay ventana de sesión y de cuánto.
- Si hay equivalente a las plantillas aprobadas.
- Si los comentarios en publicaciones entran por la misma API que los DMs.
- Modelo de costos.

Ninguna de esas respuestas se da por supuesta en el diseño: el adaptador expone capacidades, y el núcleo pregunta en vez de asumir.

## Aprendizajes verificados

Ninguno. No hay acceso.
