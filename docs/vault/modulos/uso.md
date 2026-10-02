---
estado: vivo
fecha: 2026-09-09
modulo: facturacion
tags: [modulo, medicion, uso, facturacion]
---

# Módulo: medición de uso

Adelantado de fase 4 a fase 1 (ARCH §15). **Mide hechos; no cobra.** Qué se factura de esto es [[02-PREGUNTAS-ABIERTAS#P-21]] y sigue en la lista de parada. Migración 0013.

## Qué se mide y dónde

| Métrica | Se emite en | Cuándo cuenta |
|---|---|---|
| `messages.inbound` | worker, `procesar-entrante` | cada entrante nuevo (un reenvío duplicado no suma: ADR-006) |
| `messages.outbound` | worker, `enviar-saliente` | cuando el proveedor **acepta** el mensaje; lo encolado o fallido no |
| `templates.sent` | worker, `enviar-saliente` | además de `messages.outbound`, si el tipo es `template` |
| `conversations.opened` | worker, `procesar-entrante` | conversación **creada** o **reabierta desde `closed`** por un entrante. Un contacto que sigue escribiendo no suma |
| `media.stored_bytes` | worker `descargar-media` y API `confirmarSubida` | bytes que ocupan sitio de verdad; un medio deduplicado por sha256 no suma |

Sin métrica todavía: asientos (es un estado, no un evento; lo medirá el cierre de periodo), ejecuciones de bot y créditos de IA (no existen los módulos).

## Cómo

`registrarUso(c, {tenantId, metric, quantity?, dedupKey, occurredAt?, meta?})` en `@crmapp/db`, **dentro de la transacción del hecho**: si el mensaje no se guarda, el evento tampoco. Escribe tres cosas: la clave (`usage_event_keys`, sin particionar, idempotencia), el evento (`usage_events`, particionada por mes) y el agregado (`usage_rollups`, `ON CONFLICT … quantity + EXCLUDED.quantity`). La factura lee `usage_rollups`; jamás cuenta `messages`.

**Trade-off del agregado en línea.** Una fila caliente por inquilino/métrica/mes. Bajo S-3 (<200 msg/s) no se nota. Si se notara, se pasa a un job de agregación y la tabla no cambia de forma. La alternativa —solo job— habría dejado el consumo visible con retraso, y el punto de medir es que el cliente no se sorprenda el día de cobro.

`GET /v1/cuenta/uso` devuelve el periodo (mes UTC), el plan, todas las métricas (0 si no hay) y `plans.limits` con el uso emparejado cuando existe métrica (`conversaciones_mes` ↔ `conversations.opened`; `agentes` sin métrica → `usado: null`). **No bloquea nada al superar un límite**: qué pasa entonces es decisión de producto (P-21).

## Precreación de particiones (de paso)

Hasta hoy las particiones solo se creaban al migrar: a los tres meses, caída de la ingesta. 0013 hace `app.ensure_partitions_ahead` **SECURITY DEFINER** con `EXECUTE` para `crmapp_relay`, y el worker la llama al arrancar y a las 03:00 UTC (BullMQ `upsertJobScheduler`, cola `maintenance`). Fallo del job = error en log con prefijo `MANTENIMIENTO FALLIDO`; cuando haya alertas (ARCH §13) es la primera.

Lección: en una función `SECURITY DEFINER` que **crea objetos sin esquema**, el `search_path` debe empezar por `public` (`public, pg_temp`), no por `pg_catalog`: PostgreSQL crea la tabla en el primer esquema del path y en `pg_catalog` está prohibido.

## Cómo verificarlo en cinco minutos

```
pnpm --filter @crmapp/db test       # uso.test: idempotencia, agregado, RLS, SECURITY DEFINER
pnpm --filter @crmapp/worker test   # entrante/saliente/medios suman; mantenimiento.test precrea 4 tablas
pnpm --filter @crmapp/api test      # uso.e2e: GET /v1/cuenta/uso
```

## Topes de canales y de IA (PR-108, 2026-10-02)

Hasta aquí solo se aplicaba el tope de `agentes`. Lo pidió el dueño: aplicar también `canales` y `creditos_ia_mes`.

| Tope | Dónde corta | Qué NO corta |
|---|---|---|
| `canales` | Al **conectar** un canal nuevo, y al **renovar** uno desconectado | Los canales ya conectados siguen recibiendo y enviando |
| `creditos_ia_mes` | Al pedir un borrador de IA, **antes** de llamar al proveedor | Escribir a mano; ningún huésped se queda sin respuesta |

Los dos cumplen ADR-011: pasarse avisa o frena una acción del equipo, nunca corta lo que le llega al cliente.

**Lo que no era obvio:**

- **Desconectar no borra la fila** (conserva las conversaciones), así que el conteo excluye `status = 'disconnected'`. «Uso del plan» contaba todas las filas y lo mismo hacía el primer borrador del tope: desconectar no habría liberado plaza.
- **La puerta de atrás**: renovar el token de un canal desconectado lo reconecta. Sin comprobarlo ahí, se podía conectar uno, desconectarlo, conectar otro y renovar el primero. Hay test, visto fallar sin la comprobación.
- **Cerrojo de asesoría** (`pg_advisory_xact_lock`) y no `FOR UPDATE`: el rol de la aplicación no puede actualizar `subscriptions`, y no debe.
- El tope de canales se comprueba **antes** de hablar con Meta (no se verifica ni se suscribe la WABA si no cabe) y otra vez dentro de la transacción.
- `topeDelPlan` en `@crmapp/db`: sin suscripción o sin clave en el plan es «sin tope», la misma regla que `cabeUnoMas`.

La cuenta de desarrollo pasó a **Scale** en la base local, a pedido del dueño, para que los topes no le frenen las pruebas.

