---
estado: vivo
fecha: 2026-09-11
modulo: embudo
tags: [embudo, leads, kanban, hotel, reservas]
---

# Módulo — Embudo de reservas

Tablero kanban de oportunidades. Migración `0018_embudo`, API en `apps/api/src/embudo/`, pantalla en `apps/web/src/pantallas/Leads/`, y la creación automática en `apps/worker/src/leads.ts`. Decisión de fondo: [[ADR-013-lead-no-es-conversacion]].

![[2026-09-11-embudo-reservas.png]]

## Qué es un lead aquí

Una **oportunidad de venta**, no un hilo. Cuelga del contacto y guarda la conversación que lo originó. El mismo huésped que vuelve en enero abre uno nuevo sin pisar el de Fiestas Patrias. Como mucho **uno abierto por contacto y embudo**, y lo impone un índice único parcial — no una comprobación de la aplicación, que sería una carrera esperando a ocurrir.

## El tablero se llena solo

La columna «Consulta» no la rellena nadie a mano: cada conversación nueva o reabierta abre un lead **en la misma transacción que el mensaje**. Con un evento en el outbox habría una ventana en la que el agente ve la conversación y el jefe no ve la tarjeta; y si el trabajo fallara, no habría lead nunca y nadie se enteraría.

El **título sale del primer mensaje del cliente** —«Dos bungalows para Fiestas Patrias»— y no de un «Lead #4821». Es lo que hace que la tarjeta se pueda leer sin abrirla.

## Lo que decide el pronóstico es el tipo, no el nombre

Cada etapa declara si es `abierta`, `ganada` o `perdida`. El cliente renombra columnas cuando quiere; una suma que dependiera de que una columna se llame «Confirmada» se rompería el primer día. Cambiar el tipo de una etapa **cambia el estado de los leads que tiene dentro**, porque si no el tablero y el pronóstico contarían cosas distintas.

## Tres decisiones de interfaz que se notan

![[2026-09-11-embudo-ficha.png]]

- **Arrastrar no es la única forma de mover.** Cada tarjeta lleva un desplegable «Mover a». El arrastre nativo no funciona con teclado ni con lector de pantalla, y en una pantalla pequeña con seis columnas el desplegable es más rápido incluso con ratón. Sin librería de arrastre: es dependencia pesada y el gesto lo cubre HTML.
- **Se edita en la ficha, no en la tarjeta.** Una tarjeta con campos editables es una tarjeta que se dispara al arrastrarla.
- **Borrar una etapa pregunta a dónde van sus leads.** Una etapa con veinte reservas dentro no se borra con un «¿seguro?»; el servidor lo exige igual, así que la interfaz no inventa una regla suya.

## Lo que cuesta

- El orden dentro de una columna **no se guarda**: manda la fecha del último movimiento. Kommo deja arrastrar arriba y abajo; eso pide una columna de posición y un reordenado que es una fuente permanente de empates.
- Cada columna trae sus **primeras 25 tarjetas** y el total real. Lo que no cabe se dice («y 14 más»), no se disimula.
- La política de visibilidad de [[ADR-008-visibilidad-entre-agentes]] se escribió para conversaciones y habla de equipos; los leads no tienen equipo, así que aquí se aplica por responsable y queda **algo más restrictiva**. Es el lado correcto en el que equivocarse.
- **No hay disponibilidad**: dos agentes pueden confirmar el mismo bungalow para el mismo fin de semana. Decisión explícita del usuario para la primera entrega.

## Dónde nace el embudo de una cuenta

En `app.sembrar_embudo()`, una función SQL de la migración 0018 que llaman **dos** sitios: la propia migración, para los inquilinos que ya existían, y el alta de cuenta, para los que vengan. Con el SQL copiado en TypeScript, el día que alguien añada una etapa por defecto solo la tendría la mitad de los clientes.
