---
estado: aceptado
fecha: 2026-09-07
modulo: salesbots
tags: [adr, salesbots, estado, durabilidad, bullmq]
---

# ADR-002 — Motor de Salesbots: máquina de estados propia

## Contexto

Un flujo puede quedarse esperando tres días una respuesta del contacto, y tiene que sobrevivir a un deploy. El requisito pide además log de ejecución paso a paso para auditar por qué el bot dijo lo que dijo, y modo prueba sin envío real.

Es el problema clásico de *workflows duraderos*, para el que existe herramienta especializada.

## Decisión

**Máquina de estados propia**: tabla `flow_runs` en PostgreSQL como estado, `flow_run_steps` como log, y *delayed jobs* de BullMQ como temporizador, con un barrido periódico de respaldo.

Dos piezas hacen que funcione:

- **Red de seguridad sobre los temporizadores.** Un flujo esperando es una fila con `wait_until` y un delayed job. Si el job se pierde —Redis reiniciado, cola purgada—, un cron cada minuto sobre `WHERE status = 'waiting' AND wait_until < now()` lo recupera. El estado vive en PostgreSQL; Redis es solo el despertador, y un despertador es reemplazable.
- **Idempotencia por paso con compare-and-swap.** Cada avance es `UPDATE flow_runs SET current_node_id = <nuevo> WHERE id = <id> AND current_node_id = <actual>`. Si la actualización afecta a cero filas, otro worker ya avanzó y este job se descarta. Un job duplicado no envía dos veces.

Además, el estado del flujo se escribe en la **misma transacción** que el mensaje que lo provoca, y publica a la cola por el outbox que ya existe por el requisito 8.2. Eso es gratis aquí y no lo es con un motor externo.

## Costo de lo elegido

Nos comemos, y hay que presupuestarlo: durabilidad, reintentos con backoff, versionado del flujo en vuelo (qué pasa cuando se publica una versión nueva mientras hay 400 runs corriendo la anterior), cancelación, y toda la observabilidad. Semanas de trabajo que Temporal regala. La respuesta al versionado en vuelo debe estar en el diseño del módulo, no improvisada: **`flow_runs` apunta a `flow_version_id`, no a `flow_id`** — los runs en vuelo terminan con la versión que empezaron.

## Alternativas descartadas

### Temporal
Habría ganado con flujos de decenas de pasos con compensaciones, o con necesidad de reproducción determinista para auditar. Lo que lo descarta hoy no es técnico: es un servidor más que operar —o Temporal Cloud, costo recurrente que entra en la lista de parada— y un modelo mental que nadie más maneja en un proyecto de un solo implementador. El día que el bot haga algo raro delante de un cliente, con `flow_runs` la respuesta está en un `SELECT`; con Temporal está en una interfaz que hay que aprender primero.

### BullMQ Flows / encadenar jobs sin tabla de estado
Habría ganado con flujos de dos o tres pasos sin esperas largas. Descartado: el estado viviría solo en Redis, que no es la fuente de verdad de nada más en este sistema, y el log de auditoría paso a paso habría que construirlo igual.

### Motor de reglas de terceros embebido
Descartado sin evaluar en profundidad: dependencia de peso, lista de parada, y el constructor visual exige que el formato del grafo sea nuestro.

## Cómo se revierte

Migrar a Temporal después es viable —el grafo del flujo es un JSON portable y `flow_runs` se puede drenar dejando de admitir runs nuevos—, pero implica convivencia de dos motores durante semanas. No es barato, pero tampoco es una puerta de un solo sentido.

## Señal de revisión

Si aparecen flujos que necesiten compensación transaccional (deshacer pasos ya ejecutados) o si el tiempo dedicado a arreglar el motor supera al dedicado a los nodos.
