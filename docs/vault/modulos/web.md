---
estado: vivo
fecha: 2026-09-09
modulo: web
tags: [web, frontend, convenciones, css, diseño]
---

# Módulo — Aplicación web

`apps/web`: React 19 + Vite 7, sin enrutador ni gestor de estado todavía (dos pantallas y un `useState`). PR-17. Capturas reales en `adjuntos/2026-09-09-bandeja-claro.png` y `-oscuro.png`.

![[2026-09-09-bandeja-claro.png]]

## Convención de estilo (fijada por el usuario, decidida en [[ADR-010-css-en-web]])

**CSS Modules por componente** (`Nombre.tsx` + `Nombre.module.css`) sobre tokens y base globales en `packages/ui` (`tokens.css`, `base.css`). Nada en línea, nada de CSS-in-JS, ninguna utilidad en `className`. Lo vigila `scripts/check-architecture.sh` (busca `style={{`, imports de styled-components/emotion y de `@crmapp/core|db|…` desde la web).

La única excepción admitida: el **color de una etiqueta es dato del usuario**, no estilo nuestro. Se pasa como propiedad personalizada `--tag` al nodo mediante un `ref` (`pintar(color)` en `Filtros.tsx`); el CSS hace el resto con `color-mix()`.

## Dirección de diseño y por qué

Sujeto: un agente de una pyme peruana de autopartes atendiendo WhatsApp e Instagram. Trabajo principal: **responder rápido sin perder ninguna**; la información crítica es cuánto queda de ventana y qué conversaciones marcó el usuario como importantes.

- **Paleta**: grafito y cobalto como únicos colores de la interfaz (`--graphite-*`, `--cobalt-*`). El color lo aportan los canales (WhatsApp verde, Instagram magenta, TikTok negro) y las etiquetas del usuario. Se descartaron a propósito el crema+terracota y el negro+ácido: son los tics del diseño generado.
- **Vidrio**: paneles `.glass` con `backdrop-filter` sobre un fondo con dos degradados radiales (el desenfoque necesita algo que desenfocar). `prefers-reduced-transparency` y `@supports not (backdrop-filter)` convierten el vidrio en superficie opaca **una sola vez, en tokens.css**, no componente a componente.
- **Tipografía**: Instrument Sans (una sola familia), numerales tabulares para horas y contadores.
- **Tema**: `light-dark()` + `color-scheme: light dark` en `:root`; `data-theme` fuerza uno. Sin JavaScript de tema.
- **El elemento memorable** es la **franja de color** al borde de cada conversación (etiquetas apiladas, Zenvia) y las etiquetas como filtro visible arriba de la lista. Todo lo demás está callado a propósito.
- **Ventana de sesión**: la API manda el instante (`ventanaExpiraEn`); la web pinta «23 h 33 min» en verde, ámbar bajo dos horas, gris cerrada. `vista/tiempo.ts` es presentación pura y tiene tests.

## Lo que no se negocia

**Cero lógica de negocio.** El compositor envía y, si la API dice 409 `fuera_de_ventana`, pinta el motivo y las `plantillasSugeridas` que vienen en la respuesta. No sabe qué es una ventana. Test: `Compositor.test.tsx`.

## Estructura

```
src/
  api/        cliente.ts (fetch + ErrorDeApi), tipos.ts (formas de la API, tal cual)
  estado/     sesion.ts (token en localStorage; #sesion= solo en desarrollo), ruta.ts (hash: #c=<id>, #ajustes/<seccion>)
  vista/      tiempo.ts (formatos)
  pantallas/  Acceso, Bandeja (tres paneles: lista · hilo · contacto; el contacto se oculta sin selección), Ajustes (PR-18)
  componentes/ Barra, Filtros, ListaDeConversaciones, Hilo (+Medio), Compositor, PanelDeContacto
  componentes/ajustes/ Canales (conectar/desconectar WhatsApp), Plantillas (sincronizar con Meta, estado y motivo),
               RespuestasRapidas (crear/editar/archivar), Uso (barras contra plans.limits)
```

**Roles en la web**: `gestor = rol !== 'agent'` solo decide qué botones se muestran; quien decide de verdad es la API (403). Un agente ve canales, plantillas y respuestas, pero no puede tocarlos.

Datos: sondeo cada 10 s la lista y cada 5 s el hilo abierto; WebSocket queda para después. Conversación abierta en la URL (`#c=<id>`). Vite hace proxy de `/api` a la API (sin CORS).

## Cómo verlo en cinco minutos

```
pnpm dev:api          # API en 3000
pnpm dev:web          # http://localhost:5173 (proxy /api → 3000)
pnpm --filter @crmapp/web test   # 16 tests: cliente, tiempo, Acceso, Lista, Compositor
```

## Hilos de comentarios (PR-22)

![[2026-09-09-bandeja-comentarios.png]]

Un comentario no es un DM y la interfaz lo dice: vista «Comentarios» en los filtros, etiqueta en la fila en lugar de la ventana (un hilo de comentarios no tiene ventana que agotar), y un compositor propio con **dos acciones**: «En privado» —el principal, donde se captura el lead, igual que Kommo— y «En público». Si el privado se rechaza porque la persona no acepta mensajes, se explica en tono normal y se ofrece el público; no es una avería. Ver [[instagram]].

## Defecto de CSS que costó dos capturas

Un `display: grid` sin `grid-template-columns` usa una columna implícita `auto` que **crece con su contenido**. Los paneles de la bandeja y la lista lo eran, así que una vista previa larga ensanchaba la columna y la hora y el contador de no leídos se salían del recorte. `minmax(0, 1fr)` en los tres paneles y en el `ul` lo ata. Estaba desde PR-17 y solo se vio al sembrar textos más largos: **las capturas encuentran cosas que los tests no**.

## Pendiente

- WebSocket para no sondear; virtualización de la lista si pasa de ~200 filas.
- Campos configurables en la ficha (P-25). Playwright para el recorrido completo.
