---
estado: vivo
fecha: 2026-09-11
modulo: clientes
tags: [clientes, contactos, csv, importar, exportar, gdpr, hotel]
---

# Módulo — Clientes

La ficha que llena el hotel, frente a la identidad que trae el canal. Migración `0019_clientes`, API en `apps/api/src/contactos/`, pantalla en `apps/web/src/pantallas/Clientes/`, y el lector de CSV en `packages/core/src/csv.ts`.

![[2026-09-11-clientes.png]]

## Dos fuentes, y ninguna manda sobre la otra

`contact_identities` guarda **lo que dice el proveedor** —el id de WhatsApp, el teléfono que entrega Meta, el @ de Instagram— y es un hecho suyo, inmutable ([[ADR-007-identidad-contactos]]). `contacts` guarda **lo que sabe la recepción**: correo, ciudad, de dónde salió, sus manías.

Por eso hay `contacts.phone` y también `contact_identities.phone_e164`, y no es duplicación: uno es «el número por el que escribió» y el otro «el número que el hotel tiene de este señor». Coinciden casi siempre; el día que no, manda el del negocio.

## Lo hotelero que NO está aquí

El encargo pedía guardar en el cliente la fecha de ingreso, la de salida, el tipo de habitación y las noches. **Eso no describe a la persona, describe una estancia.** Una familia que viene en julio y vuelve en enero tiene dos fechas de entrada, y con columnas en el contacto la segunda reserva borra la primera — el mismo error que ya evitamos con los leads ([[ADR-013-lead-no-es-conversacion]]).

Van en `reservations` (PR-37). En el cliente queda lo que no cambia con cada estancia: **tipo de huésped** y **observaciones**. El «historial de reservas» de la ficha es la lista de las suyas, y hoy ya muestra sus oportunidades del embudo.

## Borrar no siempre es borrar

- Un cliente **sin conversaciones ni reservas** se borra de verdad. Creado por error, no hay nada que conservar, y dejar una fila marcada sería basura.
- Uno que **ya habló con el hotel se anonimiza**: se vacían sus datos y los de su identidad —nombre, teléfono, @, foto de perfil— y la fila se queda con `anonymized_at`. Sus mensajes, sus reservas y las cuentas del mes cuelgan de ella; borrarla en cascada sería reescribir la historia del negocio para cumplir un «eliminar» que el usuario entendía como «quítalo de la lista».

La API devuelve **cuál de las dos cosas hizo**, y la interfaz lo dice. Un «eliminado» que en realidad conserva conversaciones y no lo cuenta es una mentira pequeña que se paga cara el día de una reclamación.

Borrar es de propietario o administrador. Un agente no.

## Importar: donde de verdad se duplican los contactos

![[2026-09-11-clientes-importar.png]]

El archivo que llega **no es el que uno espera**: exportado de un Excel en español (punto y coma), con BOM, saltos de Windows y una observación entre comillas con una coma dentro. Un `split(',')` falla en el primero y falla **en silencio** — parte una fila en dos y aparecen clientes fantasma.

Por eso el lector de CSV es nuestro, vive en `core`, son cien líneas y está probado entero: separador adivinado contando fuera de comillas, comillas dobles escapadas, filas cortas rellenadas en vez de descartadas. Una librería habría traído más superficie de la que resuelve.

Tres decisiones del importador:

- **Actualiza, no falla.** Importar dos veces el mismo archivo da el mismo resultado, no dos mil duplicados. La unicidad la imponen los índices parciales de 0019 (teléfono y correo, por inquilino y solo entre los no anonimizados).
- **Nunca se cae entero.** Cada fila que no entra se cuenta con su número de línea. Un archivo de 2.000 filas que revienta en la 1.999 y no guarda nada es peor que no tener importación.
- **Dice lo que ignoró.** Las columnas que no reconoció se devuelven y se pintan. Tragárselas en silencio es la forma rápida de perder la confianza.

**El prefijo telefónico lo elige quien importa**, en la pantalla y a la vista. Un archivo local trae «999111222» y WhatsApp habla en internacional; completarlo a escondidas sería adivinar el país de cada fila.

El CSV viaja **dentro del JSON**, no como `multipart`: son unos cientos de kilobytes de texto y montar subida temporal, limpieza y borrado para eso sería pagar por un problema que no tenemos. Eso sí, obligó a subir el tope del cuerpo de express a 2 MB en `main.ts` — los 100 kB de serie no dan ni para 2.000 filas.

Exportar devuelve el CSV **dentro de un JSON** por un motivo concreto: la petición necesita la cabecera de sesión y un enlace de descarga del navegador no la lleva. El archivo lo arma la web con un `Blob`.

## Lo que cuesta

- La búsqueda es `ILIKE '%…%'`: no usa índice. Con miles de clientes va bien; con cientos de miles habrá que meter `pg_trgm` o una columna de búsqueda.
- No hay campos personalizados genéricos. Los del hotel son columnas tipadas —se buscan y se validan—; el día que un segundo cliente pida los suyos, entonces sí toca la tabla genérica.
- La fusión de contactos duplicados sigue siendo manual y pendiente (P-08): hoy el importador evita crear duplicados nuevos, pero no une los que ya existen.
