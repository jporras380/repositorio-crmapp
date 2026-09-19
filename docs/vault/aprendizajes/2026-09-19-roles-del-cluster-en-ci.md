---
estado: cerrado
fecha: 2026-09-19
modulo: ci
tags: [aprendizaje, ci, postgres, tests]
---

# `ALTER ROLE` no es de una base: es del clúster

## Qué pasó

El CI cayó con un fallo que no tenía nada que ver con el cambio que lo
disparó:

```
FAIL test/outbox.test.ts
error: tuple concurrently updated
  ❯ conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD '…'`)
```

## Por qué

Cada suite de test se crea **su propia base de datos** —`crmapp_test_rls`,
`crmapp_test_outbox`…— y da por hecho que así está aislada de las demás. Lo
está para las tablas. **No lo está para los roles.**

`ALTER ROLE` escribe en `pg_authid`, un catálogo **compartido por el clúster
entero**. En local no se nota porque las suites van una detrás de otra; en CI,
turbo arranca los paquetes en paralelo y `packages/db`, `packages/queue` y
`apps/api` ponen todos la contraseña de `crmapp_app` a la vez. Dos que coincidan
en el mismo instante chocan, y PostgreSQL dice —correctamente— que alguien
acaba de modificar la fila que él estaba modificando.

Que llevara semanas sin pasar no significa que sea raro: significa que depende
de cómo caigan los tiempos, y esos cambian con cada test que se añade.

## Qué se hizo

Un reintento con espera creciente, en `packages/db/src/roles.ts`, alrededor de
cada `ALTER ROLE` de los tests (22 sitios). La orden es **idempotente** —poner
dos veces la misma contraseña deja lo mismo—, así que repetirla es seguro.

Se descartó `pg_advisory_lock`: los bloqueos consultivos son **por base de
datos**, y aquí cada suite está en la suya. Serializarlas obligaría a abrir una
conexión extra a una base común solo para el candado, y añadiría un sitio nuevo
donde quedarse colgado.

Un error que no sea ese choque **no se reintenta**: una contraseña mal escrita
o un rol inexistente no mejoran repitiendo, y tragárselos cinco veces solo
retrasa el mensaje que hace falta leer.

## Lo que queda para la próxima

Cuando un test toque algo que **no** vive dentro de su base de datos —roles,
tablespaces, extensiones a nivel de clúster, replicación—, el aislamiento por
base no protege. O se serializa, o se hace idempotente y se reintenta.
