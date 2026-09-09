---
estado: aceptado
fecha: 2026-09-09
modulo: web
tags: [adr, web, css, frontend]
---

# ADR-010 — CSS en `apps/web`: CSS Modules por componente sobre tokens globales

Resuelve [[02-PREGUNTAS-ABIERTAS#P-23]]. Evaluado con `decision-eval`.

## Decisión

Elegir cómo organizar el CSS de la web para lograr estilos **revisables de un vistazo y sin colisiones** a medida que crece, dado que el usuario prohíbe estilos en línea y CSS-in-JS y que Vite trae CSS Modules sin dependencias.

## Opciones consideradas

- **A. CSS Modules** — `Componente.module.css` junto al componente; nombres de clase con ámbito automático. Nativo de Vite.
- **B. CSS plano con convención BEM y `@layer`** — mismos archivos, ámbito global, disciplina de nombres.
- **C. Vanilla Extract** — estilos en `.css.ts`, extraídos en build.
- **D. Tailwind solo vía `@apply` en CSS** — el usuario lo dejó como admisible.
- *No hacer nada* no aplica: no hay código todavía; su equivalente es B sin convención, y se descarta porque la ausencia de convención es justo el problema.

## Criterios y pesos (fijados antes de puntuar)

| Criterio | Peso | Por qué ese peso |
|---|---|---|
| Cumple la convención del usuario (CSS aparte, nada en JSX) | 5 | Es una regla explícita, no una preferencia |
| Aislamiento: colisiones al crecer | 4 | Bandeja de tres paneles, decenas de componentes, dos temas; las colisiones aparecen tarde y en silencio |
| Dependencias y tooling | 4 | Lista de parada: dependencias de peso se preguntan |
| Legibilidad para quien revisa | 3 | El usuario revisa CSS sin leer JSX |
| Costo de reversión | 3 | Cambiar de A a B o al revés es mecánico; a C o D, no |
| Tokens compartidos y tema claro/oscuro | 3 | `packages/ui` con variables CSS debe servir a todas |

## Matriz

|  | Convención (5) | Aislamiento (4) | Deps (4) | Legibilidad (3) | Reversión (3) | Tokens (3) | **Total** |
|---|---|---|---|---|---|---|---|
| **A. CSS Modules** | 5 — archivos `.css` puros | 5 — ámbito por archivo, garantizado por el bundler | 5 — cero: Vite lo trae | 4 — en dev los nombres son `Componente__clase`; en prod, hash (los devtools muestran la fuente) | 4 — quitar `styles.` y renombrar | 5 — variables CSS globales, sin fricción | **104** |
| B. BEM + `@layer` | 5 | 3 — depende de disciplina; un `.item` repetido se detecta en producción | 5 | 5 — la clase del DOM es la del archivo | 4 | 5 | **99** |
| C. Vanilla Extract | 2 — el estilo vive en `.ts`: es CSS-in-TS, contra el espíritu de la regla | 5 | 3 — plugin de Vite y API propia | 3 — hay que leer TypeScript para ver el estilo | 2 — reescritura | 4 | **69** |
| D. Tailwind `@apply` | 4 — admitido, pero el vocabulario de utilidades se cuela igual | 3 | 2 — dependencia, config y build; pierde su ventaja principal (utilidades en JSX) al prohibirlas | 3 | 2 — el vocabulario impregna todo el CSS | 3 — dos sistemas de tokens | **64** |

## Prueba de inversión

Si A perdiera 5 puntos empataría con B: **es un empate técnico entre A y B**, no un ganador claro. Se decide por el criterio que más distingue: el aislamiento, porque su fallo (dos componentes pisándose una clase) aparece meses después, en producción y sin error, mientras que todo lo demás es idéntico. Y el costo de haberse equivocado es el más bajo de la tabla.

## Recomendación

**CSS Modules por componente, sobre tokens y base globales en `packages/ui`.**

- `packages/ui/src/tokens.css`: variables de color, tipografía, espaciado, radio, sombra y **material glass**, con tema claro/oscuro por `prefers-color-scheme` y `data-theme`. `base.css`: reset mínimo y `@layer tokens, base, components`.
- Cada componente: `Nombre.tsx` + `Nombre.module.css`. Nada de `style=`, nada de utilidades en `className`.
- Nombres de clase **en inglés y descriptivos** dentro del módulo (`.item`, `.unread`), sin prefijos BEM: el ámbito ya lo da el módulo.
- En desarrollo, `css.modules.generateScopedName = '[name]__[local]'` para que el revisor lea el DOM.

## Por qué no las otras

- **B**: gana en legibilidad del DOM y pierde en lo único que no se puede arreglar con una regla de lint. Si algún día CSS `@scope` es *Baseline widely available*, B recupera el aislamiento sin bundler y la decisión se revisa.
- **C**: no cumple la regla del usuario tal como está escrita.
- **D**: una dependencia para usar solo su 20 % menos útil.

## Qué haría cambiar esta decisión

- Si `@scope` llega a Baseline ampliamente disponible → reconsiderar B (mismos archivos, sin bundler en medio).
- Si aparece la app móvil con React Native → los tokens siguen en `packages/ui` como JSON/CSS; los módulos no viajan, y no pretendían hacerlo.
- Si el usuario cambia la convención y admite utilidades en JSX → D pasa a tener sentido.

## Costo de revertir

De A a B: renombrar `*.module.css` → `*.css`, sustituir `styles.x` por `"x"` y prefijar nombres. Mecánico, una tarde. Se vuelve caro solo si se abusa de `:global` o de composición entre módulos, que por eso quedan prohibidos salvo justificación en comentario.
