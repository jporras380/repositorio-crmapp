---
estado: vivo
fecha: 2026-09-14
modulo: reservas
tags: [reservas, hotel, pagos, embudo, criterio-10]
---

# Módulo — Reservas

Quién, cuándo, qué habitación, a cuánto y qué ha pagado. Migración `0022_reservas`, ciclo de vida en `packages/core/src/reservas.ts`, API en `apps/api/src/reservas/`, pantalla en `apps/web/src/pantallas/Reservas/` y el bloque de la conversación en `apps/web/src/componentes/PanelDeContacto/ReservaDeConversacion.tsx`.

![[2026-09-14-reservas.png]]

## Se crea desde la conversación

Es el **criterio de éxito 10** del encargo y la razón de que el botón viva en la ficha de la conversación, no en la pantalla de Reservas: el huésped pide la reserva en el chat, y obligar al agente a salir de la conversación para crearla es justo lo que la bandeja única existe para evitar. La ficha muestra primero si ya hay reserva —lo segundo que pregunta cualquiera al abrir un hilo— y después ofrece crear otra.

![[2026-09-14-conversacion-reserva.png]]

El formulario **es el propio cotizador** ([[hotel]]) con un botón más, que lleva la cifra: «Crear reserva por S/ 1.306». Un formulario aparte sería una segunda forma de pedir el precio, y tarde o temprano daría otro.

## El precio lo pone el servidor, y se COPIA

La API **no acepta un total**: el esquema de entrada es estricto y un `total` en el cuerpo es un 400. La reserva pide la cotización al mismo `HotelService` que usa el cotizador y copia sus líneas —cada noche con su precio y el nombre de la tarifa, cada servicio con su cantidad—. Si la pantalla pudiera mandar el total, un número mal escrito sería una reserva mal cobrada.

Copiar y no apuntar a la tarifa es lo que hace que **cambiar el catálogo mañana no cambie la reserva de hoy** (hay test: se sube el precio base a S/ 990 y la reserva sigue en S/ 280).

Lo único que la persona pone a mano es un **descuento**, que queda como línea propia, con motivo, y no puede superar el total.

**Las fechas de una reserva no se editan.** Cambiar de fechas es recotizar con el catálogo de hoy, que puede cambiar el precio que se le dio al cliente; hacerlo en silencio desde un formulario es como se cobra de más. Se cancela y se crea otra, y las dos quedan.

## Avisos que se aceptan a sabiendas

Una cotización con una noche sin precio **no se reserva**. Los avisos que sí tienen cifra real —mínimo de noches, más personas de las que caben, **entrada en el pasado**— bloquean hasta que alguien marque «reservar igualmente». A veces el hotel hace excepciones; lo que no se hace es pasarlas por alto sin enterarse.

La **entrada en el pasado** salió al probar con datos reales: se creó una reserva de julio el 14 de septiembre y el sistema no dijo nada. Equivocarse de año es de los errores más comunes en recepción. «Hoy», a efectos del aviso, es **el día UTC de ayer**: no se guarda la zona horaria de cada cuenta, y con el día UTC a secas un hotel de Lima vería «ya pasó» entre las 19:00 y la medianoche. Ayer en UTC ya terminó en todo el planeta: el aviso puede llegar un día tarde, pero nunca salta por error.

## El ciclo de vida, en `core`

```
pendiente ──confirmar──▶ confirmada ──llegar──▶ en_casa ──salir──▶ finalizada
    └──────cancelar──────────┴──▶ cancelada
```

Lo que NO existe, a propósito:

- **No se cancela a quien ya está en casa.** Si se va antes, es una salida anticipada; «cancelar» borraría del historial que durmió allí.
- **No hay check-in sin confirmar.** Obligar a confirmar primero es lo que deja constancia de quién aceptó la reserva.
- **Finalizada y cancelada son terminales.** Si el cliente vuelve, es otra reserva.

La web **no decide** qué botones enseñar: pinta las `acciones` que devuelve la API. Si la web decidiera las transiciones, un día ofrecería «cancelar» a alguien que ya está en la habitación. Cancelar pide confirmación; confirmar, no, porque confirmar se deshace cancelando y cancelar no se deshace nunca.

## Confirmar gana el lead

En la misma transacción, la oportunidad del embudo pasa a la **primera etapa de tipo `ganada`** —por tipo, no por nombre: el hotel puede llamarla «Confirmada» o «Pagada»— y se rellena su importe si estaba vacío. Una reserva confirmada con su lead todavía en «Cotización enviada» es un embudo que miente. Cancelar no pierde el lead: una cancelación a menudo se vuelve a reservar.

## Habitación y solapes

Al reservar se vende un **tipo**; qué habitación concreta se decide después. No se puede asignar una de otro tipo: el precio copiado ya no correspondería.

Sin motor de disponibilidad, por decisión explícita. Lo único que se comprueba es lo barato y grave: **dos reservas vivas en la misma habitación que comparten noche**. Se **avisa**, en rojo y con enlace a la otra reserva; no se bloquea. Salir el 30 y que otro entre el 30 no es solape: el día de salida no es noche.

## Pagos

Del huésped al hotel —nada que ver con `subscription_payments`, que es el hotel pagándonos a nosotros—. Métodos de Perú: efectivo, Yape, Plin, transferencia, tarjeta. Yape y Plin no son «transferencia»: se concilian distinto. El saldo dice lo pendiente y, si se pagó de más, lo dice como **saldo a favor**, no como un pendiente negativo. En una reserva cancelada no se cobra.

## Lo que falta

- Devoluciones: hoy se anotan en la reserva, no se registran como movimiento.
- Disponibilidad y calendario de ocupación.
- Zona horaria por cuenta, para que el aviso de fecha pasada sea exacto al día.
