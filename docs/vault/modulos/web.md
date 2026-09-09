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
