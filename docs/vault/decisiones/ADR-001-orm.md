---
estado: aceptado
fecha: 2026-09-07
modulo: db
tags: [adr, orm, postgres, particionado, rls]
---

# ADR-001 — ORM: Drizzle

## Contexto

El esquema tiene dos requisitos que un ORM puede estorbar más que ayudar:

1. `messages` va **particionada por rango de fecha desde el diseño** (requisito 8.7), con precreación de particiones y una tabla de idempotencia aparte. Ver [[ADR-006-particionado-idempotencia]] (pendiente).
2. **RLS** con `SET LOCAL app.tenant_id` por transacción (requisito 8.5). Exige que el `SET LOCAL` y la consulta viajen por la **misma** conexión física. Ver [[ADR-005-rls]] (pendiente).

Ambos son DDL y control de conexión, no modelado de datos.

## Decisión

**Drizzle ORM** sobre `node-postgres`.

## Costo de lo elegido

- Menos batería incluida. Las relaciones anidadas son más verbosas que un `include` de Prisma, y consultas con tres niveles de anidación se vuelven ruidosas.
- Lo que Prisma regala hay que escribirlo: borrado lógico, middleware, convenciones de auditoría.
- Ecosistema menor. Menos respuestas cuando algo falla de forma rara.
- `drizzle-kit` genera migraciones, pero las de particionado y RLS se escriben a mano en SQL. Eso es deseable aquí, pero significa que nadie nos avisa si olvidamos una política RLS en una tabla nueva. **Mitigación obligatoria:** un test que recorra el catálogo de PostgreSQL y falle si existe una tabla con columna `tenant_id` sin RLS activada y forzada.

## Alternativas descartadas

### Prisma
Habría ganado con un equipo grande y rotativo, donde el modelo declarativo evita más errores de los que cuesta el DDL manual; o simplemente si no particionáramos `messages`.

El argumento que lo descarta **no** es "Prisma no soporta SQL crudo" — hoy lo soporta bien y tiene driver adapters. Es que `prisma migrate` mantiene su propia idea del esquema y trata como *drift* todo lo que introduzcamos a mano: particiones, políticas RLS, índices parciales, la tabla `message_keys`. Esa fricción no es de arranque, es permanente: aparece en cada migración durante toda la vida del proyecto. Con un implementador solo, pelearse con el generador cada semana es peor que escribir SQL.

### Kysely (query builder puro)
Habría ganado si no quisiéramos ninguna capa de modelado. Descartado porque Drizzle ya da el mismo control sobre el SQL emitido y además una definición de esquema en TypeScript de la que derivar tipos sin paso de generación. Kysely obligaría a mantener los tipos a mano.

### SQL crudo con un pool y nada más
Habría ganado en un servicio de tres tablas. Con ~35 tablas y multi-tenancy, la ausencia de tipos derivados del esquema convierte cada refactor en una búsqueda de texto.

## Cómo se revierte

Caro pero acotado: el esquema SQL y las migraciones sobreviven intactos —son SQL, no un formato propietario—, y lo que hay que reescribir son las consultas. Estimación: proporcional al número de repositorios, no exponencial. La decisión que **sí** sería irreversible es el particionado, no el ORM.

## Señal de revisión

Si entra un segundo o tercer desarrollador y el tiempo perdido en consultas verbosas supera al ganado en control del SQL, se reabre.
