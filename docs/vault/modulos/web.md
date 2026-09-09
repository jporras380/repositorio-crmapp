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

## Paneles ajustables (PR-24)

![[2026-09-09-bandeja-ajustable.png]]

La bandeja era de tres paneles fijos. El usuario lo dijo claro: «donde sale los mensajes veo que es estático, debería permitir moverlo o achicarlo o cerrar». Kommo y Zenvia lo tienen, y no es cosmética: la lista útil de quien atiende comentarios cortos no es la misma que la de quien negocia por mensajes largos.

**Rejilla → flex.** Con `grid-template-areas` cada combinación —lista sí/no, ficha sí/no, con o sin conversación— pedía su propia plantilla de columnas, y salían seis. Con flex, plegar un panel es no pintarlo. El ancho llega en dos variables CSS (`--ancho-lista`, `--ancho-ficha`) que escribe el separador.

**El arrastre no pasa por React.** `pointermove` escribe la variable CSS del contenedor directamente; el estado se toca una sola vez, al soltar. Redibujar lista, hilo y ficha en cada píxel se nota a simple vista. Los paneles llevan `contain: layout paint` para que cambiar el ancho de uno no obligue a recalcular el interior de los otros.

**Accesible de verdad**: el asa es el *window splitter* de ARIA (`role="separator"` enfocable con `aria-valuenow/min/max`), se mueve con las flechas, `Inicio`/`Fin` van a los extremos y el doble clic vuelve al ancho normal. Los mínimos no son estéticos: por debajo de 232 px la fila pierde la vista previa; por debajo de 248 px la ficha parte los botones de estado.

**La preferencia vive en el navegador**, no en el servidor: un portátil de 13" y un monitor de 27" piden repartos distintos, así que ni siquiera es igual para la misma persona. Llevarla al servidor costaría tabla, ruta y migración. `estado/paneles.ts` es el único sitio donde tocar el día que haya que sincronizarla.

**Lo que cambia con el ancho se pregunta al contenedor, no a la pantalla**: el hilo declara `container-type: inline-size` y el texto del botón «Detalles» desaparece con `@container`. Una media query se equivocaría en cuanto alguien pliegue la lista.

**Por debajo de 1100 px la ficha deja de ser columna y se superpone**; en móvil ocupa la pantalla entera. Eso obliga a dos cosas que no existían: un aspa dentro de la ficha —el botón «Detalles» que la abrió queda debajo— y fondo casi opaco, porque flotando sobre el hilo el vidrio deja leer las burbujas de abajo. En móvil, además, manda la conversación abierta: si hay una, se ve el hilo con su botón de volver; si no, la lista.

De paso, tres arreglos que se veían en la captura anterior: las cinco vistas de la lista se **recortaban** contra el borde del panel (`flex: 1 1 0` con `nowrap` no encoge por debajo del texto) y ahora pasan a dos filas; el hilo lleva **separadores de día** pegados arriba —«Hoy», «Ayer», la fecha— porque sin ellos dos mensajes de días distintos se leen como seguidos; y con la lista plegada las burbujas se iban a los dos extremos de 1600 px, así que la conversación se queda en una columna centrada de 64 rem.

## Panel de control y material de vidrio (PR-23)

![[2026-09-09-panel-claro.png]]

**El material.** La primera version del vidrio no se leia como vidrio: el fondo era casi plano, y un `backdrop-filter` sin nada detras produce un panel gris. Ahora el fondo lleva tres focos de color **frios** —cobalto y acero, sin magenta: esto es la herramienta de un mostrador, no una app de consumo— y el vidrio es mas transparente (0.42) con el reflejo del borde superior dentro de `--shadow-glass`. Ese `inset 0 1px 0` es lo que separa cristal de plastico translucido.

Con superficies semitransparentes hay que decidir que sigue siendo opaco: los bordes que **recortan** (el punto de canal sobre el avatar) y lo que **flota** (el desplegable de respuestas rapidas) usan `--surface-solida`, o se lee lo de debajo.

**El panel.** Lo primero es lo accionable, y cada cifra enlaza a la bandeja ya filtrada: un numero que no se puede pulsar no sirve. La metrica propia es **Ventanas por cerrar**: conversaciones cuya ventana de 24 h expira en menos de dos horas. Ningun CRM de los que hemos visto la tiene, y sale gratis porque `session_expires_at` ya es un instante calculado (ARCH §9). La tarjeta se tiñe muy levemente y lleva franja de color al borde: teñir el fondo entero de ambar sobre azul se leia rosa, y rosa dice «error» cuando esto solo dice «te toca».

**Primera respuesta: mediana, no media.** Una conversacion olvidada un fin de semana dispara la media y deja de describir al equipo. Y se descartan las duraciones negativas en vez de maquillarlas: aparecen con datos importados, donde `created_at` no es el primer entrante.

## Hilos de comentarios (PR-22)

![[2026-09-09-bandeja-comentarios.png]]

Un comentario no es un DM y la interfaz lo dice: vista «Comentarios» en los filtros, etiqueta en la fila en lugar de la ventana (un hilo de comentarios no tiene ventana que agotar), y un compositor propio con **dos acciones**: «En privado» —el principal, donde se captura el lead, igual que Kommo— y «En público». Si el privado se rechaza porque la persona no acepta mensajes, se explica en tono normal y se ofrece el público; no es una avería. Ver [[instagram]].

## Defecto de CSS que costó dos capturas

Un `display: grid` sin `grid-template-columns` usa una columna implícita `auto` que **crece con su contenido**. Los paneles de la bandeja y la lista lo eran, así que una vista previa larga ensanchaba la columna y la hora y el contador de no leídos se salían del recorte. `minmax(0, 1fr)` en los tres paneles y en el `ul` lo ata. Estaba desde PR-17 y solo se vio al sembrar textos más largos: **las capturas encuentran cosas que los tests no**.

## Pendiente

- WebSocket para no sondear; virtualización de la lista si pasa de ~200 filas.
- Campos configurables en la ficha (P-25). Playwright para el recorrido completo.
