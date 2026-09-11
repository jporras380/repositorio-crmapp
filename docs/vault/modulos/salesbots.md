---
estado: vivo
fecha: 2026-09-11
modulo: salesbots
tags: [salesbots, flujos, fase-3, motor, adr-002]
---

# Módulo — Salesbots

Fase 3. El motor está en `apps/worker/src/flujos.ts`, el dominio del grafo en `packages/core/src/flujos.ts` y el editor en `apps/api/src/flujos/`. Tablas en la migración `0015_flujos`. Decisión de fondo: [[ADR-002-motor-salesbots]].

## Dónde vive cada cosa, y por qué ahí

**El grafo decide; el worker ejecuta.** `packages/core` responde a una sola pregunta —«estando en este nodo y habiendo pasado esto, ¿qué hay que hacer y a dónde se va?»— y devuelve **efectos descritos**, no ejecutados. El worker los ejecuta dentro de una transacción.

Eso no es purismo: es lo que hace que el **modo prueba sin envío real** que pedía el requisito salga gratis y, sobre todo, seguro. Simular es llamar a las mismas funciones y no ejecutar los efectos. La alternativa —una bandera `prueba` repartida por el motor con un `if` en cada envío— es exactamente la clase de bandera que un día se queda a `false` en producción y le manda un mensaje de prueba a un cliente real.

## Los siete nodos, y por qué solo siete

`mensaje`, `esperar_respuesta`, `pausa`, `condicion`, `etiquetar`, `asignar`, `fin`. Con eso se cumple el criterio de salida de la fase —calificar un lead sin humano— y se amplía cuando un flujo real lo pida. Un constructor visual con cuarenta tipos de nodo es un lenguaje de programación mal hecho, y cada nodo nuevo es superficie que hay que validar, versionar y explicar.

Dos detalles que parecen menores y no lo son:

- **`esperar_respuesta` tiene dos salidas**: contestó y no contestó. Mezclarlas obliga al siguiente paso a adivinar cuál fue, y «no contestó» casi siempre merece otro trato que «contestó».
- **`pausa` no es una espera corta.** Duerme sin escuchar: un entrante no la adelanta, y mientras dura, esa conversación no puede disparar ningún otro bot. Por eso el tope es **24 horas** y no 30 días como la espera — el costo de una pausa es tiempo sordo, y conviene que sea poco. Sirve para lo que parece una tontería y no lo es: no soltar dos mensajes en el mismo segundo, que es lo que delata a una máquina.
- **`condicion` lee la respuesta del CONTEXTO, no del suceso.** La condición llega un paso después de la espera, ya con la entrada «entrar». Si solo mirara el suceso, *todas* las condiciones caerían siempre por la rama de escape: un bug silencioso que ningún error revela, solo un bot que nunca acierta. Hay un test que lo fija.

## Lo que se valida al publicar, y el problema que de verdad importa

Guardar un borrador roto es gratis; publicarlo no, porque publicar es lo que lo pone a hablar con clientes. `validarGrafo` mira destinos inexistentes, pasos inalcanzables, mensajes vacíos y esperas imposibles, pero el hallazgo que justifica la función es **`bucle_sin_espera`**: un ciclo que no pasa por ninguna espera envía mensajes a la velocidad de la red. No es una molestia — es dinero del cliente y su número reportado por spam en minutos.

Se detecta cortando las aristas que salen de las esperas: si en ese grafo recortado sigue habiendo un ciclo, el bucle es infinito. Un ciclo **que espera** es legítimo: es un recordatorio. Una **pausa no corta el ciclo**, y es deliberado: un bucle con pausas sigue enviando para siempre, solo que más lento, y «más lento» no es «no».

El motor además corta por número de pasos por vuelta, pero eso es contener el incendio; la validación lo evita.

## Idempotencia: dos veces lo mismo no envía dos veces

BullMQ entrega al menos una vez, así que un job duplicado es lo normal, no una anomalía. La defensa es doble:

1. La ejecución se toma con `FOR UPDATE`: dos jobs de la misma ejecución se serializan en vez de pisarse.
2. Cada avance es un compare-and-swap contra `current_node_id`. Si el `UPDATE` afecta a cero filas, otro worker ya avanzó y este job se retira.

Y una regla de producto encima: **un solo bot vivo por conversación**. El índice único parcial impide repetir el mismo flujo; la comprobación del motor impide que dos flujos distintos hablen a la vez, que para el contacto es lo mismo que hablar con dos personas que no se coordinan.

## El bot atraviesa la misma puerta que el agente

`enviarPorConversacion` de [[envio]]: suscripción, estado de la conversación, ventana de 24 h y capacidades del canal. Que envíe una máquina no le da permisos extra. Si la puerta lo rechaza —ventana cerrada, por ejemplo— la ejecución se marca **fallida con el motivo** y se para: un bot que no puede hablar no sigue caminando el grafo, porque acabaría parado en un nodo cualquiera con un log que dice que todo fue bien.

## Sobrevivir a un deploy

Es literalmente el criterio de salida. Un flujo esperando es una fila con `wait_until` más un delayed job de BullMQ. Si el job se pierde —Redis reiniciado, cola purgada—, un barrido cada minuto lo recupera leyendo `flow_runs`. **Redis es el despertador; la verdad está en PostgreSQL**, y un despertador es reemplazable.

El barrido necesita mirar por encima de RLS, y se resuelve como en la migración 0006 y por las mismas razones: una política acotada a esa tabla para el rol del relay, **nunca `BYPASSRLS`**, más permiso **por columna** — el barrido puede ver qué ejecución despertar y de quién es, y no puede leer el contexto del flujo ni queriendo.

## Versionado en vuelo

`flow_runs` apunta a `flow_version_id`, no a `flow_id`. Guardar cambios crea una versión; publicar decide cuál dispara. Las cuatrocientas ejecuciones a medias terminan con el grafo con el que empezaron: si se sobrescribiera, saltarían a nodos que en su grafo no existen.

**Pausar no cancela.** Deja de disparar y ya; lo que está corriendo termina. Cortar a mitad una conversación deja al contacto esperando una respuesta que no llega.

## El constructor (PR-27)

![[2026-09-10-constructor-de-flujos.png]]

**Una columna de pasos, no un lienzo con nodos arrastrables.** Un lienzo libre cuesta mucho más —posiciones que guardar, aristas que dibujar, zoom, colisiones— y con seis tipos de nodo el resultado sería un diagrama bonito que se lee peor que una lista. La columna **se ordena sola** recorriendo los enlaces desde el inicio: el camino principal cae de arriba abajo, las ramas cuelgan etiquetadas y lo que no se alcanza aparece aparte, bajo «Sin conectar», donde se ve que sobra. El día que un flujo tenga treinta pasos y tres caminos paralelos, el lienzo se gana su coste; hoy no.

**La validación no vive en la web.** No puede —`apps/web` no importa `core`, lo vigila la guarda— y duplicarla sería peor. La comprobación viaja **con la simulación**, que es la misma llamada: lo que ves antes de publicar es literalmente lo que el servidor decidirá al publicar. De regalo, el botón de activar se apaga solo mientras haya avisos.

**Insertar engancha y borrar re-engancha.** Un paso nuevo entra ENTRE uno y su siguiente, y al quitar un paso, lo que apuntaba a él pasa a apuntar a lo que él apuntaba. Sin eso, cada borrado parte el flujo en dos y llena la pantalla de avisos que el usuario no provocó.

**La prueba se pinta como una conversación** porque es lo que hay que juzgar: no si el grafo es correcto —de eso avisan los problemas— sino si lo que dice el bot suena a alguien con quien uno querría hablar. Lo que el bot *hace* sin decir nada (etiquetar, asignar, cerrar) se ve como nota gris: el contacto no lo ve.

Se añadió `GET /v1/usuarios` para el paso «asignar»: id, nombre y rol, sin correos — para elegir a quién asignar basta el nombre.

## El mapa y las plantillas (PR-31, [[ADR-012-constructor-de-flujos]])

![[2026-09-11-mapa-del-flujo.png]]

El usuario comparó con el constructor de su Kommo y pidió «algo así o mejor». La evaluación dio **empate técnico** entre dejar la columna y añadir un mapa; lo desempató el criterio que él mismo estaba señalando —ver las ramas— y no el total.

**El mapa se calcula, no se coloca.** Capas por recorrido en anchura desde el inicio: la distancia al inicio es la columna, el orden de aparición es la fila. No hay coordenadas en el grafo, así que el formato no cambia y las ejecuciones en vuelo siguen apuntando a su versión sin enterarse. Un lienzo arrastrable habría metido posiciones dentro de un grafo que ya está en producción.

**El mapa no edita: selecciona.** Pulsar un nodo marca su tarjeta y la trae a la vista. Dos sitios en vez de uno, sí — a cambio de no mantener zoom, colisiones ni enrutado de aristas para siempre.

Detalles con motivo: el color va en la **franja** del nodo y no en el fondo (cinco fondos de color y deja de leerse el texto); lo inalcanzable se dibuja **apagado y punteado**, porque el mapa también tiene que enseñar lo que sobra; y las aristas llevan etiqueta —«responde», «no responde», las palabras de cada caso— que es lo único que convierte un diagrama en una explicación.

**La altura del mapa se pasa como dato.** Una fila `auto` de rejilla con un contenedor que desplaza no toma la altura de su contenido: el mapa salía aplastado a diez píxeles. Se calcula ya la disposición, así que la altura se sabe; va como propiedad personalizada, igual que el ancho de las barras del panel.

![[2026-09-11-galeria-de-plantillas.png]]

**La galería**: cinco plantillas publicables de verdad, agrupadas por para qué sirven. Cada tarjeta enseña **su mapa real**, el mismo componente que se verá al editar — un catálogo con ilustraciones que no coinciden con lo que sale es la forma más rápida de perder la confianza en la primera pantalla. Las plantillas viven en la web porque son contenido de la interfaz: en cuanto se crea el flujo, el grafo es del inquilino y la plantilla deja de existir.

## El relevo: cuando habla una persona, el bot se calla (PR-32)

![[2026-09-11-pausa-en-el-bot.png]]

Un agente entra a rescatar una conversación, escribe dos frases, y el bot —que seguía dormido esperando su turno— suelta encima «¿Sigues ahí?». Para el contacto son dos personas que no se hablan entre ellas. Se arregla en dos sitios, y hacen falta los dos:

- **Al responder**, la puerta de envío cancela las ejecuciones vivas de esa conversación (`status='cancelled'`, `error='humano_tomo_el_control'`) y deja una fila `relevo` en `flow_run_steps`, que es lo que después contesta «¿por qué el bot dejó de hablar?». Vive en `packages/envio/src/relevo.ts` y **no** en el motor: la puerta es el único sitio por el que sale un mensaje, así que es el único que ve «ha hablado un humano» sin que nadie tenga que acordarse de avisar. El costo, dicho: `envio` pasa a conocer la tabla `flow_runs`.
- **Después**, `conversations.human_reply_at` impide que el siguiente mensaje con una palabra clave meta otro bot encima del agente. Se borra al **cerrar** la conversación, y eso devuelve el turno a los bots — sin ningún plazo mágico que afinar. Costo: un bot de palabra clave no volverá a saltar en un hilo abierto que un humano atendió, aunque pasen semanas; se arregla cerrándolo.

Se intentó primero sin columna, deduciendo el estado de `messages` y `closed_at`. No vale: reabrir desde la bandeja pone `closed_at` a NULL y reabrir por un entrante no, así que el mismo hilo daba dos respuestas distintas según por dónde se hubiera reabierto.

El despertador de Redis de una ejecución cancelada seguirá sonando a su hora y no hay que borrarlo: cuando suene, no encontrará la ejecución en `waiting` y se retirará. Hay test.

## Lo que falta

- **Horas activas.** El bot de Kommo tiene horario; el nuestro contesta a las 4 de la mañana.
- **Nodos que Kommo tiene y nosotros no:** nota interna, reacción, lista de WhatsApp, Round Robin, «ir a otro paso».
- **Disparadores.** Dos frente a los ~10 de Kommo, pero la mitad de los suyos dependen de un **embudo de leads** que aquí no existe.
- **Enforcement.** El uso de bots ya se mide contra `bot_runs_mes`, pero pasarse no tiene consecuencia: qué ocurre al superar un límite es parte de P-21.
