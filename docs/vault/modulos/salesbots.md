---
estado: vivo
fecha: 2026-09-10
modulo: salesbots
tags: [salesbots, flujos, fase-3, motor, adr-002]
---

# Módulo — Salesbots

Fase 3. El motor está en `apps/worker/src/flujos.ts`, el dominio del grafo en `packages/core/src/flujos.ts` y el editor en `apps/api/src/flujos/`. Tablas en la migración `0015_flujos`. Decisión de fondo: [[ADR-002-motor-salesbots]].

## Dónde vive cada cosa, y por qué ahí

**El grafo decide; el worker ejecuta.** `packages/core` responde a una sola pregunta —«estando en este nodo y habiendo pasado esto, ¿qué hay que hacer y a dónde se va?»— y devuelve **efectos descritos**, no ejecutados. El worker los ejecuta dentro de una transacción.

Eso no es purismo: es lo que hace que el **modo prueba sin envío real** que pedía el requisito salga gratis y, sobre todo, seguro. Simular es llamar a las mismas funciones y no ejecutar los efectos. La alternativa —una bandera `prueba` repartida por el motor con un `if` en cada envío— es exactamente la clase de bandera que un día se queda a `false` en producción y le manda un mensaje de prueba a un cliente real.

## Los seis nodos, y por qué solo seis

`mensaje`, `esperar_respuesta`, `condicion`, `etiquetar`, `asignar`, `fin`. Con eso se cumple el criterio de salida de la fase —calificar un lead sin humano— y se amplía cuando un flujo real lo pida. Un constructor visual con cuarenta tipos de nodo es un lenguaje de programación mal hecho, y cada nodo nuevo es superficie que hay que validar, versionar y explicar.

Dos detalles que parecen menores y no lo son:

- **`esperar_respuesta` tiene dos salidas**: contestó y no contestó. Mezclarlas obliga al siguiente paso a adivinar cuál fue, y «no contestó» casi siempre merece otro trato que «contestó».
- **`condicion` lee la respuesta del CONTEXTO, no del suceso.** La condición llega un paso después de la espera, ya con la entrada «entrar». Si solo mirara el suceso, *todas* las condiciones caerían siempre por la rama de escape: un bug silencioso que ningún error revela, solo un bot que nunca acierta. Hay un test que lo fija.

## Lo que se valida al publicar, y el problema que de verdad importa

Guardar un borrador roto es gratis; publicarlo no, porque publicar es lo que lo pone a hablar con clientes. `validarGrafo` mira destinos inexistentes, pasos inalcanzables, mensajes vacíos y esperas imposibles, pero el hallazgo que justifica la función es **`bucle_sin_espera`**: un ciclo que no pasa por ninguna espera envía mensajes a la velocidad de la red. No es una molestia — es dinero del cliente y su número reportado por spam en minutos.

Se detecta cortando las aristas que salen de las esperas: si en ese grafo recortado sigue habiendo un ciclo, el bucle es infinito. Un ciclo **que espera** es legítimo: es un recordatorio.

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

## Lo que falta

- **Interfaz.** Hoy los flujos se crean por API. El constructor visual es el PR siguiente.
- **El humano toma el control.** En Kommo, si un agente responde a mano, el bot se calla. Aquí todavía no: hay que decidir si cancelar la ejecución o solo pausarla.
- **Enforcement.** El uso de bots ya se mide contra `bot_runs_mes`, pero pasarse no tiene consecuencia: qué ocurre al superar un límite es parte de P-21.
