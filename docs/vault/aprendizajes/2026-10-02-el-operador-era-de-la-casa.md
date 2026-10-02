---
fecha: 2026-10-02
modulo: facturacion
tags: [aprendizaje, tests, multi-inquilino]
---

# El operador era de la casa

El 28 de septiembre se arregló la boleta: la consola subía el archivo a la cuenta equivocada y daba 404, con los tests en verde. La causa del verde era que, en el archivo de tests, **el operador era miembro de la cuenta sobre la que actuaba**. Con eso, cualquier fallo que cruce cuentas es invisible: las dos cuentas son la misma.

Arreglar ese caso y no mirar los demás habría sido no aprender nada. Se hizo inventario de **todo** lo que el operador hace dentro de otra cuenta (diez métodos) y se repitió con un cliente ajeno de verdad. Salieron dos fallos más, los dos por la misma razón: `users` solo enseña a los miembros de la cuenta, y el operador no lo es.

## La regla

Un test de algo que **cruza cuentas** necesita **dos cuentas que no compartan nada**. Si el actor y el afectado pueden ser la misma cuenta, el test no puede ver el fallo que existe para probar.

## Lo que lo tapó dos veces

1. Sembrar con SQL directo en la cuenta buena (la boleta): se prueba un camino que la pantalla nunca sigue.
2. Un respaldo en la pantalla (`pedidoPor ?? 'Soporte'`): el dato vacío no se ve como hueco, se ve como un genérico creíble.

Ver [[facturacion]] §El nombre de quien entra y §La boleta estaba rota.
