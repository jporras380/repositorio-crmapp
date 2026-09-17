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

## Tiempo real sin WebSocket (PR-49, 2026-09-16)

La bandeja preguntaba cada 10 s y el hilo cada 5 s. Ahora se entera en el momento y la recarga periódica queda de respaldo (60 s y 30 s).

- **`pg_notify` desde `escribirEnOutbox`**, en la MISMA transacción del hecho: PostgreSQL lo entrega al confirmar, así que nadie recibe el aviso de algo que se deshizo. Va ahí y no en el relay porque es un aviso, no una entrega: quien no esté conectado se lo pierde y da igual. Lo que no se puede perder sigue yendo por el outbox.
- **Una sola conexión `LISTEN` por proceso de API**, y el reparto a las pantallas en memoria filtrando por inquilino. Una conexión por pantalla agotaría el pool con veinte agentes. Hay test de que una cuenta no recibe los eventos de otra.
- **Se sirve como SSE y no WebSocket**: no añade dependencias, atraviesa proxies y túneles, y el navegador reconecta solo. La web usa `fetch` en vez de `EventSource` porque `EventSource` no admite cabeceras y el token acabaría en la URL —y de ahí a los registros y al historial—.
- **El aviso no lleva datos**: tipo, id y conversación. La pantalla vuelve a pedir por los endpoints de siempre, con los permisos de siempre; el flujo no puede enseñar nada que el agente no pudiera ver.
- Latido cada 25 s para que ningún proxy corte la conexión por inactividad, y reconexión con esperas crecientes hasta un minuto.

## Avisar de un mensaje nuevo (PR-50, 2026-09-16)

Con los eventos en vivo ya se sabe al instante que entró un mensaje; faltaba que el agente se enterara cuando no está mirando el CRM.

- **Solo si la pestaña no está a la vista.** Avisar de lo que se está leyendo es ruido. Volver a la pestaña cuenta como visto y limpia el contador.
- **El contador va en el título** (`(3) CRM`): se ve desde otra pestaña y no necesita permiso de nadie. La notificación del navegador es el extra.
- **El permiso se pide con un botón** y solo mientras no se haya decidido. Un navegador que pregunta solo se contesta «bloquear», y de ahí no se vuelve.
- **Solo avisa lo que ENTRA** (`mensaje.recibido`, `comentario.recibido`). Avisar de lo que enviamos despertaría a todo el equipo con cada respuesta.
- Todas las notificaciones comparten `tag`: cinco mensajes seguidos reemplazan un aviso en vez de apilar cinco ventanas.

## Emojis y sonido (PR-55, 2026-09-16)

Dos huecos que el usuario nombró: «no hay la sección de emojis en el chat» y «si me llegara un mensaje nuevo el sonido que debe emitir no llega».

### Emojis: a mano, sin dependencia

Las librerías de emoji pesan entre 300 KB y 1,5 MB porque traen **todos** con sus nombres en varios idiomas, sus tonos de piel y a menudo sus imágenes. Un agente de hotel usa treinta. Cargar un megabyte en cada apertura del CRM para eso lo paga el cliente en cada visita.

El panel son cuatro grupos elegidos para un hotel —gestos, hotel y viaje, comida, trato y pagos— pintados **con la fuente del sistema**: así se ven como los ve el cliente en su móvil, que es más honesto que un set propio de imágenes que no se parece a lo que llega.

- **El emoji entra donde está el cursor**, no al final. Escribir «Gracias!» y que el emoji salga pegado a la G es lo que hace que estos paneles acaben sin usarse.
- **Los más usados suben arriba**, guardados en `localStorage` por navegador.
- Se cierra con Escape o pulsando fuera.
- **Lo que se pierde:** no hay buscador ni tonos de piel. Quien necesite otro emoji sigue teniendo el teclado del sistema (Win+. en Windows).

### El sonido, y por qué no llegaba

Dos notas cortas sintetizadas con la Web Audio API: sin archivo que descargar, sin licencia que comprobar y funciona sin conexión. Volumen bajo y menos de medio segundo — quien recibe cien mensajes al día no puede oír cien campanas.

**La causa de que no sonara nunca no es que faltara el sonido, es la política de los navegadores:** desde 2018 ninguno reproduce audio hasta que la persona ha interactuado con la página. Un CRM que se abre y se deja quieto es exactamente el caso que bloquean. Por eso el contexto de audio se crea con el **primer gesto** del agente —un clic o una tecla, los que sean— y no al cargar.

- **El sonido suena aunque la pestaña esté a la vista**, y ahí se separa de las otras dos reglas de [[web]] §Avisar. El agente puede estar leyendo OTRA conversación del mismo CRM: lo que entra es tan nuevo para él como si estuviera en otra pestaña. El contador del título sigue respetando la visibilidad.
- **Campana para silenciar** en la cabecera de la lista, no enterrada en Ajustes: quien atiende con una recepción llena necesita callarlo en un clic. Se recuerda por navegador, y **encenderlo suena una vez** — porque encenderlo *es* el gesto que el navegador exige, y de paso deja oír cómo suena.
- Si el navegador lo bloquea de todos modos, no se rompe nada: el título de la pestaña no necesita permiso de nadie.

### Cómo comprobarlo en menos de 5 minutos

1. Abrir una conversación, pulsar 🙂 y elegir un emoji: entra donde estaba el cursor.
2. Volver a abrir el panel: el que se usó está arriba, en «Los que más usas».
3. Pulsar la campana de la cabecera: suena una vez. Pedirle a alguien que escriba al WhatsApp del hotel: suena al llegar.
4. Pulsar la campana otra vez (🔕) y repetir: ya no suena, pero el título sigue contando.

## Los servicios de desarrollo recargan solos (PR-58, 2026-09-16)

`dev:api` y `dev:worker` arrancaban con `tsx` **sin `watch`**. El proceso se quedaba con el código que tenía al arrancar y nadie lo decía: se arreglaba un fallo, se volvía a probar, y el arreglo no estaba puesto porque el worker llevaba horas en marcha.

Pasó de verdad con PR-57: la imagen seguía fallando después del arreglo, y la pista fue que los mensajes fallidos tenían `wamid` —o sea, el camino viejo de la URL— cuando el código nuevo ni siquiera pide una.

Ahora los dos arrancan con `tsx watch`. Precio: reiniciar el worker corta un job en vuelo, y el relevo del outbox lo reintenta; es preferible a depurar un proceso que miente sobre qué código ejecuta.

`--clear-screen=false` para no borrar los logs anteriores en cada recarga, que es justo lo que se está mirando cuando se depura.

## Un solo comando para arrancar (PR-61, 2026-09-17)

Arrancar el CRM eran **tres ventanas** (API, worker, web) más **dos pasos que se olvidan**: levantar Docker y aplicar migraciones. Y olvidarse de uno no se parece nunca a su causa:

- Con el worker parado, todo funciona y los mensajes salientes se quedan en cola sin que nadie lo diga.
- Con la API parada, el túnel «no conecta» — porque detrás no hay nadie escuchando. Pasó el 17/09.
- Con el worker viejo en marcha, un arreglo recién hecho parece no funcionar. Pasó el 16/09 y costó media hora.

`pnpm arranca` hace las cinco cosas en orden: comprueba PostgreSQL y levanta Docker si hace falta, **espera a que acepte conexiones** (`docker compose up -d` vuelve antes), aplica migraciones, y arranca los tres procesos con los logs prefijados por quién habla. Ctrl+C los baja a los tres — dejar un worker huérfano es la forma de acabar con dos compitiendo y un misterio que depurar.

### Decisiones

- **Sin dependencias.** `spawn` de Node basta; una librería para pintar tres prefijos no se paga con otra dependencia que mantener.
- **Si las migraciones fallan, se para ahí.** Arrancar con el esquema viejo es la forma de que el fallo aparezca media hora después y en otro sitio.
- **No abre el túnel, y es deliberado.** `cloudflared` da una URL nueva en cada arranque y hay que pegarla en Meta a mano. Automatizarlo a medias sería peor: daría la sensación de que ya está resuelto. Se recuerda en pantalla, con los tres pasos y el aviso de que la URL cambia.

### Cómo comprobarlo en menos de 5 minutos

`pnpm arranca`, y en el mismo terminal se ve la infraestructura, las migraciones, los tres servicios y el recordatorio del túnel. La web en `localhost:5173`, la API en `localhost:3000`.

## La señal de vida de cada canal (PR-62, 2026-09-17)

`channel_accounts.last_event_at` existía desde la fase 0 y **solo se leía**. La pantalla de Canales decía «sin eventos todavía» siempre, incluso en el número que llevaba días recibiendo mensajes. Era el dato que contesta la pregunta que más veces ha costado tiempo en este proyecto —«¿por qué no llega nada?»— y estaba en blanco.

Ahora lo escribe el worker al procesar cada webhook, y la pantalla lo enseña **en relativo**: «hace 3 min», «hace 5 h». Una fecha completa obliga a restar de cabeza justo cuando algo va mal y hay prisa.

### Decisiones

- **Una escritura por minuto y canal como mucho.** Un solo mensaje trae hasta tres webhooks de estado seguidos; sin ese filtro, cada uno sería otra escritura sobre la MISMA fila, y esa fila la leen todos los envíos. Saber el minuto basta para lo que sirve.
- **Es pasivo, no avisa.** El usuario descartó por ahora el aviso activo de «no entran mensajes desde las X». Esto no lo sustituye: hace que el dato exista y se lea de un vistazo cuando se abre Canales.
- **Una fecha futura no se pinta.** Un reloj desajustado diría «hace -3 min»; es mejor callarse.

### Lo que atrapó el test

La primera versión del `UPDATE` comparaba `last_event_at < $2 - interval '1 minute'` sin castear. PostgreSQL toma `$2` como desconocido, lee `$2 - interval` como *interval menos interval* y falla la sentencia entera — **tumbando la ingesta completa de ese webhook**. Los tests lo cazaron antes de llegar a `main`; en producción habría sido «dejaron de entrar mensajes» sin más pista.

### Cómo comprobarlo en menos de 5 minutos

Ajustes → Canales, y escribir al número desde un móvil: la línea del canal pasa a «hace un momento».

## La guarda de «declarado y sin usar» (PR-68, 2026-09-17)

En un solo día aparecieron **siete fallos de la misma familia**: una capacidad, una columna o un endpoint que existía, estaba probado, y **no lo usaba nadie**. Ninguno rompía nada de forma ruidosa:

| Qué | Daño silencioso |
|---|---|
| `limitesDeMedios` | Un vídeo de 38 MB viajaba hasta Meta para fallar allí |
| `requiereUrlPublicaParaMedios` | Las fotos salían y no llegaban, marcadas «Enviado» |
| `last_event_at` | «Sin eventos todavía» con el canal recibiendo mensajes |
| `respuestasPrivadasPorComentario` | Se podía gastar dos veces algo que solo se usa una vez |
| `handoff_reason` | El bot se rendía sin decirlo |
| `aplazar` | Función entera sin ningún botón |
| Deshacer la fusión | Ídem, y la escribí yo el mismo día |

Los encontró un barrido a mano. `scripts/check-puertas.mjs` lo hace ahora en cada build, dentro de `pnpm arch:check`.

### Qué comprueba

1. **Columnas** declaradas en el esquema Drizzle que no aparecen en ningún otro archivo.
2. **Métodos del cliente web** que no llama ningún componente.

### La decisión que la hace útil

**Para acallar un hallazgo hay que escribir el motivo.** Se anota en `PERMITIDOS`, con su razón, y ahí conviven dos cosas distintas que conviene distinguir al leer: lo que está así **a propósito** (cobro manual, segundo factor sin construir) y lo que es **deuda con nombre** (`DEUDA:`). Una lista de excepciones sin razones sería otra vez el problema que la guarda resuelve.

### Lo que NO comprueba, y por qué

Las capacidades de canal (`CapacidadesDeCanal`) no entran: se consumen dentro de `validarContraCapacidades`, que sí las usa todas, y detectarlo requeriría entender el flujo de datos, no buscar texto. Esa familia se cubre con lectura y tests.

### Cómo comprobarlo en menos de 5 minutos

Añade un método al cliente web sin llamarlo desde ningún sitio y ejecuta `pnpm arch:check`: falla y lo nombra. Se probó así antes de darla por buena — una guarda que nunca falla no protege nada.

### Deuda que la guarda deja anotada

- Borrar un tipo de habitación.
- Crear un lead a mano (el huésped que llama por teléfono).
- Ver las ejecuciones vivas de un bot.

## Sesiones que se pueden cerrar (PR-70, 2026-09-17)

Hasta aquí el JWT **no tenía estado**: se firmaba, se entregaba y valía hasta caducar. Dos consecuencias que no se ven hasta que hacen falta:

1. **Un token robado no se podía anular.** Ni cambiando la contraseña.
2. **Nadie sabía desde dónde estaba entrando**, ni el propio dueño de la cuenta, que es justo quien reconocería un sitio raro.

Migración 0033: tabla `sessions` con IP, dispositivo, última vez y revocación. El token lleva dentro el identificador de su sesión (`sid`), y la guarda comprueba en cada petición que sigue abierta.

### El precio, dicho claro

**Una lectura por petición autenticada.** Un token sin estado es más rápido justamente porque nadie pregunta si sigue valiendo. Se paga con una búsqueda por clave primaria, y `last_seen_at` se escribe como mucho una vez por minuto para no castigar una fila que se lee constantemente.

### Decisiones

- **La fila no se borra al cerrar**, se marca. El historial de accesos es lo que deja ver «alguien entró desde otra ciudad el martes»; borrarlo esconde justo lo que se estaba mirando.
- **Los tokens antiguos sin `sid` se aceptan hasta caducar.** Invalidarlos de golpe echaría a todo el mundo en el despliegue, y caducan solos.
- **«Cerrar las otras» no se cierra a sí misma.** Es el caso de «esto no era yo» y dejar a alguien fuera de su propia sesión mientras arregla un susto es cruel.
- **De `x-forwarded-for` se queda la primera IP**: el cliente. El resto son proxies.

### Lo que salió al probarlo

- **El alta de cuenta reventaba** con violación de clave foránea: la sesión se creaba en otra conexión mientras la transacción del alta aún no había confirmado, así que el inquilino todavía no existía. Ahora se pasa el cliente de la transacción en curso.
- **Un `user-agent` con tildes llega mangleado**: una cabecera HTTP no es UTF-8. No es un problema real —los navegadores mandan ASCII— pero el test lo destapó y queda anotado.

### Lo que esto habilita

El cambio de contraseña ya puede cerrar las demás sesiones de verdad. Sin esta tabla, ese botón habría sido una promesa vacía: por eso va primero.

### Cómo comprobarlo en menos de 5 minutos

Entrar desde dos navegadores, `GET /v1/sesiones` desde uno, cerrar la del otro y comprobar que su token devuelve 401 `sesion_cerrada` aunque su firma siga siendo válida.
