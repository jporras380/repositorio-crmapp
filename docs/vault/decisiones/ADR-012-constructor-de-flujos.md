---
estado: aceptado
fecha: 2026-09-11
modulo: salesbots
tags: [adr, salesbots, web, constructor, lienzo, kommo]
---

# ADR-012 — Constructor de flujos: mapa calculado, no lienzo arrastrable

## Contexto

El usuario comparó con el constructor de Salesbots de su Kommo —galería de plantillas, lienzo con nodos y aristas, menú de «agregar el siguiente paso», diálogo de disparadores— y pidió «algo así o mejor», en claro y con mejor color.

El constructor de PR-27 es una columna de pasos que se ordena sola siguiendo los enlaces. Funciona, pero con tres ramas hay que leer selectores para saber a dónde va cada una: la forma del flujo no se ve.

Evaluado con `decision-eval`; los criterios se fijaron antes de puntuar.

## Opciones

| | Qué era |
|---|---|
| **A. Columna** (no hacer nada) | Lo de PR-27. |
| **B. Lienzo propio** | Nodos colocables, aristas, zoom, posiciones guardadas en el grafo. |
| **C. Librería de lienzo** (React Flow) | Lo mismo, hecho por otros. **Dependencia pesada: lista de parada.** |
| **D. Híbrido** | Mapa SVG con disposición **calculada** (sin arrastrar, sin guardar posiciones) + edición en la tarjeta del paso. |

Descartado sin evaluar: editor de JSON del grafo — resuelve la legibilidad al revés.

## Criterios y pesos

| Criterio | Peso | Por qué |
|---|---|---|
| Tiempo hasta funcionar | 5 | Un implementador y las fases 5–7 por delante. |
| Legibilidad con ramas | 5 | Es el problema señalado. |
| Coste de reversión | 4 | Guardar posiciones cambia el formato del grafo, que ya está en producción con ejecuciones vivas apuntando a versiones. |
| Encaje con las reglas | 4 | CSS aparte, sin CSS-in-JS, sin dependencias pesadas sin permiso. |
| Mantenimiento | 3 | Zoom, colisiones y enrutado son código para siempre. |

**Totales: A 90 · B 69 · C 70 · D 88.**

## Prueba de inversión

Si A hubiera sacado cinco puntos menos, ganaría D: **empate técnico**. El total no decide. Decide el criterio de más peso donde se separan —legibilidad con ramas, A=2 frente a D=4— y ese criterio es justo lo que el usuario pidió.

## Decisión

**D.** Un mapa arriba que enseña el flujo entero con sus ramas etiquetadas («responde», «no responde», las palabras de cada caso), y la edición donde ya funcionaba: en la tarjeta del paso. Pulsar un nodo lo selecciona y trae su tarjeta a la vista; el mapa **no edita**.

Tres consecuencias que no son detalles:

- **La disposición se calcula** (capas por recorrido en anchura desde el inicio). No hay coordenadas en el grafo, así que el formato no cambia y las ejecuciones en vuelo siguen intactas.
- **Lo inalcanzable se dibuja apagado y con borde punteado**, en su propia columna. El mapa enseña también lo que sobra.
- **El color va en la franja del nodo, no en el fondo.** Cinco fondos de color convierten el mapa en un circo y dejan de leerse los textos.

Y con ello, la **galería de plantillas**: cinco flujos publicables de verdad, agrupados por para qué sirven, cada tarjeta con **su mapa real** —el mismo componente, no una ilustración—, porque un catálogo cuyos dibujos no coinciden con lo que sale es la forma más rápida de perder la confianza en la primera pantalla.

## Costo de lo elegido

- No se pueden colocar los nodos a mano. Si a alguien no le gusta dónde cae uno, no hay nada que hacer.
- La disposición por capas se degrada con flujos anchos: muchas ramas al mismo nivel crecen hacia abajo y obligan a desplazarse.
- Sigue habiendo dos sitios donde mirar (mapa y tarjetas), cuando un lienzo de verdad sería uno solo.

## Qué haría cambiar esta decisión

- Si un flujo real pasa de ~15 pasos o de 3 caminos paralelos, el mapa calculado se hará ilegible: entonces toca **pedir permiso para C**, que es la puerta correcta (React Flow, MIT, con su CSS aparte).
- Si aparece la necesidad de anotar el lienzo —notas sueltas, agrupar pasos—, también: eso ya no es una disposición, es un documento.

## Cómo se revierte

El mapa es aditivo: dos archivos. Borrarlos deja la columna de PR-27 intacta. Nada en la base de datos ni en el grafo depende de él — que es exactamente por lo que se eligió así.
