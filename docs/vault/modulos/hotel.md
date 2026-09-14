---
estado: vivo
fecha: 2026-09-14
modulo: hotel
tags: [hotel, habitaciones, tarifas, cotizador, precios]
---

# Módulo — Hotel

El catálogo: tipos de habitación, habitaciones, tarifas y servicios, y el cotizador. Migración `0021_hotel`, dominio en `packages/core/src/tarifas.ts`, API en `apps/api/src/hotel/`, pantalla en `apps/web/src/pantallas/Hotel/`.

![[2026-09-14-hotel.png]]

## Ningún precio escrito en el código

El encargo nombra los cuatro tipos del Apart Hotel (Bungalow Matrimonial, Familiar, Familiar VIP, Habitación Doble). **No se siembran en la migración**: se meterían en cada cuenta que se dé de alta y sus precios quedarían en un archivo que nadie del hotel puede editar. Una cuenta nueva empieza con el catálogo vacío —hay test— y se carga desde la pantalla, que es donde se cambiará después.

## Cómo se calcula un precio

Vive en `core`, puro, porque lo usan dos sitios que tienen que dar lo mismo: el cotizador que el agente abre mientras chatea y la reserva (PR-37). La web no suma nada; pregunta al servidor.

Las reglas que costaría dinero equivocar, cada una con su test:

- **Una noche va de la entrada al día antes de la salida.** Entrar el 27 y salir el 30 son tres noches. El día de salida no se cobra.
- **Se cotiza noche a noche**, no por estancia. Una estancia a caballo de dos temporadas cobra cada noche a su precio. Aplicar la tarifa del primer día a toda la estancia es la forma habitual de regalar o cobrar de más sin que nadie lo vea.
- **Si dos tarifas cubren la misma noche, gana la de rango más corto.** «Fiestas Patrias» (cuatro días) dentro de «Temporada alta» (dos meses): quien creó la corta lo hizo a propósito para esas noches. A igual rango, gana la creada después, que es la corrección de la otra.
- **Una tarifa puede aplicar solo ciertos días** (viernes y sábado), sin crear una por fecha.
- **Nunca se inventa un precio.** Una noche sin tarifa y sin precio base NO vale cero: vuelve como problema, la cotización se marca `completa: false` y la pantalla tacha el total. Dar esa cifra por teléfono es regalar una noche.
- El **mínimo de noches** y **más personas de las que caben** avisan, pero la cifra sigue siendo real.
- Los **servicios** se multiplican por lo suyo: por estancia, por noche, o por persona y noche. Tres personas, tres noches: nueve desayunos, no uno.

Las fechas son de calendario —`date` en la base, `YYYY-MM-DD` en la API— y se recorren en UTC. Con horas locales, un cambio de horario convierte tres noches en dos. El 31 de febrero se rechaza, aunque `Date` lo convierta en silencio en 3 de marzo.

Comprobado con los datos de desarrollo: Familiar, 25 al 28 de julio, 3 personas con desayuno → sábado a «Fin de semana» (S/ 312), domingo y lunes a «Fiestas Patrias» (S/ 416 cada una), nueve desayunos (S/ 162): **S/ 1.306**, que es la cuenta hecha a mano.

## Quién puede qué

Leer y cotizar, todos: recepción necesita los precios para contestar. Cambiar el catálogo, propietario o administrador. Quien no administra ve la misma pantalla **sin formularios** — esconderle precios no protege nada, y enseñarle campos que luego fallan con un 403 solo enseña a desconfiar.

Un tipo con habitaciones **no se borra**: se archiva. El servidor dice cuántas tiene.

## Lo que no hace, a propósito

- **Disponibilidad.** No hay calendario de ocupación ni se impide la sobreventa: decisión del usuario para esta entrega. Las habitaciones tienen estado —disponible, mantenimiento, fuera de servicio—, que es lo que se mira a diario.
- **Guardar el precio.** El catálogo cambia; una reserva hecha no puede cambiar con él. Por eso la reserva copiará la cotización al crearse en vez de apuntar a la tarifa.
- Temporadas recurrentes («todos los años del 26 al 30 de julio»): hoy cada año es una tarifa.
