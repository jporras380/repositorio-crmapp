---
estado: vivo
fecha: 2026-09-28
modulo: producto
tags: [aprendizaje, repaso, producto]
---

# Abrir el producto como quien acaba de comprarlo

Sin deuda con nombre y con el plan original cerrado, el usuario eligió esto
antes que añadir funciones: **mirar lo que ya existe**. Cuenta nueva, sembrada
como la tendría el hotel —equipo de tres, cuatro tipos de habitación, seis
habitaciones, etiquetas— y las 20 pantallas capturadas de una pasada.

Cinco hallazgos. Ninguno lo habría encontrado una guarda: todos son cosas que
**funcionan** y dicen algo equivocado.

## 1. La pantalla de lo que se paga decía «sin medir»

`Uso del plan`, tres de cinco líneas:

```
Agentes            sin medir / 3
Canales            sin medir / 1
Créditos de IA     sin medir / 750
```

La cuenta tenía **tres personas dentro**. Y `agentes` es la unidad de cobro
(ADR-011, cobro por asiento): la única línea que de verdad se factura salía en
blanco.

Lo peor es que el número **ya se calculaba**: la misma consulta —miembros más
invitaciones vivas— vive doce líneas más arriba, en el camino que rechaza la
cuarta invitación con un 402. Se contaba para cobrar y no para enseñar.

La causa: `limites` se rellenaba emparejando cada tope con una métrica de
`usage_events`. `agentes` y `canales` **no son un contador del mes**, son
cuántos hay ahora, así que no podían salir de ahí. Y los créditos de IA sí se
contaban desde 0038 — el plan los llama `creditos_ia_mes` y la métrica
`ai.suggestions`, y nadie los había emparejado.

### Un test que fijaba el fallo

```ts
// Límites sin métrica todavía (asientos, IA): límite visible, uso desconocido.
expect(r.body.limites.agentes).toEqual({ limite: 3, usado: null });
```

Estaba en verde, describía el comportamiento con precisión, y lo que describía
era el fallo. Un test puede documentar una carencia sin que nadie vuelva a
preguntarse si sigue siendo aceptable.

### Y un fallo mío, peor que el original

La primera versión devolvía `0` en vez del número. La suma de subconsultas
salía como `?column?`, leerla por nombre daba `undefined`, y
`Number(undefined ?? 0)` es `0`.

Un `0` es **peor que «sin medir»**: parece un dato. Lo cazó el test que acababa
de escribir, que es justo para lo que estaba.

## 2. El hueco de Clientes culpaba a filtros que no existen

> No hay clientes **con esos filtros**. Los que escriben por WhatsApp entran
> solos.

Una cuenta recién abierta no tiene ningún filtro puesto, y esa frase la manda a
revisar unos desplegables vacíos. Son dos situaciones distintas —no hay nada
todavía, y no hay nada que coincida— y ahora se dicen distinto.

## 3. Dos pantallas con el mismo nombre

El embudo se titula **«Reservas»** porque así se llama el embudo sembrado. En
el menú lateral hay otra pantalla llamada **Reservas**. El usuario pulsa dos
iconos distintos y llega a dos sitios con el mismo título.

No lo arreglé: cómo llamar a cada cosa es una decisión de producto, no mía.
Queda preguntado.

## 4. «Bots» y «flujos» para lo mismo

La pantalla se titula «Bots», el botón dice «Nuevo flujo» y el hueco dice
«Elige un flujo o crea uno». La regla de la casa —una acción mantiene el mismo
nombre en todo el recorrido— no se aplicó a los sustantivos. Misma decisión de
producto, misma pregunta.

## 5. El plan vende límites que nadie aplica

De los cinco topes de cada plan, **solo `agentes` se aplica**. `canales` y
`creditos_ia_mes` están en la tabla `plans`, se enseñan al cliente en la página
de precios, y no los comprueba nadie: las tres rutas de conexión de canal
insertan en `channel_accounts` sin mirar el tope.

Growth cuesta más que Starter en parte por permitir 3 canales en vez de 1. Hoy
esa diferencia es gratis.

**No lo arreglé, y es deliberado**: aplicarlo bloquearía la cuenta de
desarrollo del propio usuario, que está en Starter y necesita conectar
WhatsApp, Instagram y Facebook para las pruebas pendientes con Meta. Cuándo
empezar a cobrar por eso es una decisión suya.

## Lo que me llevo

Las guardas cazan lo que está **declarado y sin usar**. No cazan lo que está
usado y dice algo falso. Para eso hay que abrir el producto y leerlo como quien
lo acaba de comprar, y conviene hacerlo cada cierto tiempo aunque no haya nada
roto.
