---
estado: vivo
fecha: 2026-09-09
modulo: web
tags: [web, frontend, convenciones, css]
---

# Módulo — Aplicación web

Fase 1 en adelante. Todavía no existe código.

## Convención de estilo, fijada por el usuario el 2026-09-09

**Todo el estilo va en CSS, en archivos separados del componente.** El código fuente concentrado bajo `src/`.

Queda fuera:

- Estilos en línea (`style={{ ... }}`).
- CSS-in-JS (styled-components, emotion y similares).
- Utilidades amontonadas en el `className` del marcado. Si se usara Tailwind, sería mediante `@apply` dentro del CSS, no en el JSX.

Razón: mantiene los componentes legibles y el estilo revisable de un vistazo, sin leer JSX para saber cómo se ve algo.

**Pendiente de decidir al escribir el primer componente:** CSS Modules o CSS plano con convención de nombres. Las dos opciones cumplen la regla; es P-23.

Los tokens de diseño viven en `packages/ui` como variables CSS, para que web y móvil compartan la misma paleta sin compartir componentes.

## Lo que no se negocia

**Cero lógica de negocio aquí.** Las ventanas de sesión, los permisos y los límites de plan se calculan en la API. La web los pinta. Si algo se valida en React, está mal. El mecanismo que lo sostiene: la lógica vive en `packages/core`, y `web` no puede importarlo — lo vigila `scripts/check-architecture.sh`.

## Dirección de diseño, fijada por el usuario el 2026-09-09

**Referencias:**

- **Kommo** (captura real de la cuenta del usuario): bandeja de tres paneles — lista de conversaciones con icono de canal y contador de no leídos; ficha del lead con campos configurables por cuenta (presupuesto, dirección de entrega, método de pago, razón de pérdida…); chat a la derecha. Filtro rápido "Sin respuesta". Acciones al pie: aceptar, adjuntar, eliminar.
- **Zenvia**: **etiquetas con color como filtro de primer nivel**. El usuario marca lo importante con color y filtra por él. Ya existe `tags.color`; la bandeja debe exponer las etiquetas como filtro visible, no escondido en un menú.
- **iPhone / iOS "glass"**: superficies translúcidas, desenfoque de fondo, jerarquía por profundidad más que por bordes. Se implementa con CSS nativo (`backdrop-filter`, `color-mix`), en archivos CSS aparte según la convención de arriba. **Cuando toque, cargar `frontend-design` y `modern-web-guidance` antes de escribir el primer componente**, y decidir P-23 con `decision-eval`.

**Advertencia de accesibilidad que hay que respetar desde el primer componente:** el efecto glass reduce contraste. Todo texto sobre superficie translúcida necesita un fondo de respaldo con contraste suficiente y respetar `prefers-reduced-transparency`. Bonito y legible no son excluyentes, pero hay que decidirlo al principio.

**Campos configurables por cuenta** (como la ficha de Kommo): hoy existe `contacts.attributes jsonb`. Habrá que decidir si la conversación necesita los suyos (P-25).
