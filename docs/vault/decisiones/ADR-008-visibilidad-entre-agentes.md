---
estado: aceptado
fecha: 2026-09-09
modulo: bandeja
tags: [adr, permisos, bandeja, visibilidad, decision-eval]
---

# ADR-008 — Visibilidad de conversaciones entre agentes

Resuelve **P-09**. Evaluado con `decision-eval`; matriz completa en [[2026-09-09]].

## Contexto

Dentro de una misma cuenta, ¿qué conversaciones ve un agente? El primer cliente es un equipo pequeño donde todos atienden todo; el producto es multi-inquilino y tendrá agencias que necesitan compartimentar. Y hay un fallo de negocio que pesa más que los demás: **una conversación nueva sin asignar que nadie ve es un cliente perdido.**

## Decisión

**Política configurable por cuenta, con "todos ven todo" como valor por defecto.**

- Columna `tenants.conversation_visibility` con tres valores: `all` (por defecto), `team`, `assigned`.
- Se aplica **solo al rol `agent`**. Propietario, administrador y supervisor ven siempre todo: su trabajo es precisamente ver lo que los agentes no atienden.
- En `team`: el agente ve las asignadas a él, las **sin asignar** y las de sus equipos. Las sin asignar siempre son visibles en este modo, porque ocultarlas reproduce el fallo que más cuesta.
- En `assigned`: solo las asignadas a él. Es el modo estricto; se ofrece porque una agencia lo pedirá, no porque se recomiende.
- **Vive en la API, no en RLS.** RLS aísla inquilinos; los permisos dentro de un inquilino son de la aplicación (ARCH §6). Meter esto en políticas de PostgreSQL acoplaría el modelo de roles al esquema y lo haría carísimo de cambiar.

## Costo de lo elegido

- Una comprobación más en cada lectura de la bandeja, y el filtro tiene que aplicarse en **tres sitios** —listar, leer mensajes y enviar— o un agente podría abrir por id lo que no ve en la lista. Hay test de los tres.
- El valor por defecto expone todo dentro de la cuenta. Es lo que hace Kommo y lo que un equipo pequeño espera, pero una cuenta que necesite compartimentar tiene que cambiarlo a mano.

## Alternativas descartadas

- **Solo asignadas (estricto) como único modo.** Puntuó peor con diferencia: nadie ve las conversaciones nuevas hasta que alguien las asigna, y ese alguien tampoco las ve.
- **Todos ven todo, sin configuración.** Empate técnico con la elegida. Se descartó por reversión: añadir la política después obliga a una migración de comportamiento con agentes ya acostumbrados. Guardarla como dato hoy cuesta una columna.
- **Suyas + sin asignar + equipo como único modo.** También en el empate. Perdió por coherencia con lo que el usuario ya usa.

## Cómo se revierte

Barato: el valor por defecto es una constante y el filtro es una cláusula. Lo único que no se debería deshacer es la columna, y no estorba.

## Señal de revisión

Si la primera agencia llega antes que el primer equipo pequeño, el valor por defecto debería pasar a `team`.
