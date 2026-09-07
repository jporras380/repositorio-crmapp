---
estado: aceptado
fecha: 2026-09-07
modulo: db
tags: [adr, rls, multi-tenant, postgres, seguridad, pooler]
---

# ADR-005 — Aislamiento por RLS con `SET LOCAL` en transacción

## Contexto

Requisito 8.5: el aislamiento entre inquilinos vive en PostgreSQL, no en `WHERE tenant_id` repartidos por el código. La razón es que un `WHERE` olvidado en una consulta de 300 es una fuga de datos entre clientes — el fallo más caro que puede tener un SaaS multi-inquilino, y el único del que no se vuelve.

Con RLS activada hay dos formas de decirle a PostgreSQL de quién es la petición, y la elección está condicionada por el **pooler**: en modo transacción, una conexión se presta a otra petición en cuanto acaba la transacción.

## Decisión

**Un único rol de aplicación, con `SET LOCAL app.tenant_id` al abrir cada transacción.** Política `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` sobre toda tabla con `tenant_id`, con `ENABLE ROW LEVEL SECURITY` **y `FORCE`**.

Tres detalles que no son opcionales:

- **El rol de aplicación no es owner de las tablas.** Sin `FORCE`, el owner se salta sus propias políticas; con `FORCE` no, pero mantener la separación de roles es defensa en profundidad barata. Las migraciones corren con un rol distinto.
- **`SET` sin `LOCAL` queda prohibido por lint.** Un `SET` a secas sobrevive a la transacción y, con pooler en modo transacción, se filtra a la siguiente petición que reciba esa conexión. Ese es exactamente el bug que convierte esta decisión en una fuga.
- **El GUC lo pone un interceptor de NestJS sobre `AsyncLocalStorage`**, no cada repositorio a mano.

## Costo de lo elegido

Todo depende de que **ninguna consulta se ejecute fuera de una transacción con el GUC puesto**. Un `SELECT` suelto en un worker, un script de mantenimiento, un endpoint que se saltó el interceptor: cualquiera devuelve cero filas — o, peor, si alguien "arregla" el síntoma desactivando RLS para ese caso, devuelve las de todos.

Por eso la decisión **no está completa sin dos tests, y ambos deben existir antes que el primer endpoint**:

1. Uno que falle si alguna consulta llega a la base sin `app.tenant_id` puesto.
2. Uno que recorra el catálogo de PostgreSQL y falle si existe una tabla con columna `tenant_id` sin RLS activada y forzada. Es el que protege contra la tabla nueva que alguien añade en el mes cuatro sin acordarse de la política.

Sin esos tests esto es una promesa, no un mecanismo. Van en CI como bloqueo desde fase 0.

## Alternativas descartadas

### Un rol de PostgreSQL por inquilino
Aislamiento más fuerte: sería a prueba de bug de aplicación, no solo a prueba de olvido. Descartada por dos costos que crecen con las ventas:
- El pooler necesita **un pool por rol**. Con cientos de inquilinos son cientos de pools, y el pooler deja de amortizar conexiones, que es su única razón de existir.
- **Dar de alta un cliente pasa a ser una migración DDL** (`CREATE ROLE`, `GRANT`, políticas). El alta deja de ser un `INSERT`.

*Habría ganado* con pocos inquilinos muy grandes y una exigencia de cumplimiento que pida aislamiento demostrable a nivel de motor. Si aparece ese cliente, se reabre — y para uno solo, se puede hacer sin cambiar el modelo general.

### `WHERE tenant_id` en la capa de aplicación, sin RLS
Lo que hace casi todo el mundo. Descartada porque la seguridad pasa a depender de que nadie olvide nunca una cláusula, y la revisión que lo detectaría es justo la que este proyecto no tiene: el usuario no revisa línea a línea.

### Una base de datos o esquema por inquilino
Aislamiento perfecto y la respuesta correcta para decenas de clientes enterprise. Descartada: con el volumen de S-3 (muchos inquilinos pequeños), migrar el esquema significa recorrer N bases, y las consultas agregadas entre inquilinos —facturación, métricas de producto— dejan de ser posibles en SQL.

## Cómo se revierte

Hacia rol por inquilino: caro pero sin migración de datos, porque las políticas cambian y las filas no. Hacia esquema por inquilino: es una migración de datos completa, y es la puerta de un solo sentido de este ADR.

## Señales de revisión

- Un cliente con exigencia de cumplimiento que pida aislamiento a nivel de motor.
- Si el test de "consulta sin `app.tenant_id`" empieza a fallar de forma recurrente, el interceptor no cubre algún camino: se arregla el camino, **nunca se relaja el test**.
