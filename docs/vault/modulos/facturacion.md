---
estado: vivo
fecha: 2026-09-09
modulo: facturacion
tags: [facturacion, suscripciones, prueba, gracia, entitlements]
---

# Módulo — Facturación y ciclo de vida de la cuenta

## Qué se cobra (PR-29, [[ADR-011-modelo-de-cobro]])

**Suscripción por asiento ocupado.** El importe mensual es el precio del plan por los miembros de la cuenta, y **los asientos se cuentan, no se guardan**: una columna `seats` habría que mantenerla sincronizada con cada alta y baja, y el día que se desincronice le cobra de más a un cliente — que es el error que sí se nota. `plans.limits.agentes` pasa a ser el techo de asientos: invitar por encima devuelve `limite_de_asientos` (402), contando también las invitaciones pendientes, porque tres enviadas a la vez colarían tres asientos.

**La mensajería de Meta no pasa por nosotros.** El cliente conecta su propio WABA con su propio método de pago, como en Kommo. No la absorbemos, no la revendemos, no la conciliamos.

**El cobro es manual y lo registra el operador**, nunca el inquilino: `pnpm suscripcion:pago --cuenta=<slug> --meses=<n>`. Extiende desde lo que ya estaba cubierto —no desde hoy—, así pagar con dos días de adelanto no regala ni quita tiempo. La garantía no es «no hay endpoint», que sería una promesa: `subscription_payments` es de **solo lectura para el rol de la aplicación** (migración 0016) y hay un test que lo comprueba intentando escribir.

**Pasarse de un límite avisa; solo se corta lo nuestro.** Al 80 % aparece el aviso; al 100 % dejan de arrancar bots nuevos —los que ya corren terminan, porque cortar a mitad deja al contacto esperando— y las conversaciones entrantes **no se cortan jamás**.

`GET /v1/cuenta/suscripcion` devuelve plan, asientos, importe, hasta cuándo está cubierta la cuenta, los últimos doce pagos y los avisos. Se pinta en **Ajustes → Suscripción** (PR-30):

![[2026-09-10-suscripcion.png]]

**No hay botón de pagar, y no es un olvido.** El cobro es manual: la pantalla enseña el importe, la cobertura y el historial, y el pago se registra por fuera. Un botón que no cobra es peor que no ponerlo. Y la primera línea dice lo que el cliente necesita saber antes de preguntarlo: **el consumo de WhatsApp lo cobra Meta directamente en su cuenta; aquí solo va la suscripción.**

## El ciclo, fijado por el usuario el 2026-09-09

```
prueba (1 mes)   ──caduca sin pagar──▶  gracia (7 días)  ──▶  suspendida
activa (pagada)  ──no renueva────────▶  gracia (7 días)  ──▶  suspendida
```

| Estado | Enviar | Bots e IA | Canales | Interfaz |
|---|---|---|---|---|
| prueba / activa | Todo, según plan | Sí | Conectados | Normal |
| **gracia** (7 días) | **Solo texto.** Sin imagen, vídeo, audio, documento ni plantillas | **Detenidos** | Conectados | Normal, con aviso |
| **suspendida** | Nada | Detenidos | **Desconectados** | Solo lectura: consultar y exportar |

Implementado en `packages/core/src/entitlements.ts`. Dominio puro, sin I/O.

## Por qué la lógica vive en `core`

No es organización de carpetas. `apps/web` no puede importar `core` y lo vigila `scripts/check-architecture.sh`, así que **un cliente cuya prueba caducó no puede recuperar el envío de imágenes editando el estado de un componente**. Si la comprobación viviera en React, sería una sugerencia.

## Decisiones que evitan bugs caros

**El estado efectivo se deriva de las fechas, no de la columna `status`.** La columna es una caché que mantiene un job. Si la política confiara en ella, un cliente cuya gracia venció a las 3 de la mañana seguiría enviando hasta que el cron pasara. Hay test.

**Los días de gracia se guardan por suscripción, copiados del plan al crearla.** Si se leyeran del plan al evaluar, cambiar la gracia de 7 a 14 días alargaría la de todos los clientes vivos, retroactivamente. Hay test.

**Cancelar no corta a mitad de periodo.** Significa "no renueves", no "córtame ahora". Cortar al cancelar es quedarse con dinero por un servicio no prestado.

**El periodo pagado manda sobre la prueba.** Si el cliente paga a mitad de prueba, vale lo que compró. Sin esto, quien paga pronto se quedaría degradado al acabar la prueba pese a estar al día.

**Sin fechas, la cuenta está suspendida.** Fallar cerrado: una suscripción en estado corrupto no envía.

## Desconexión del canal al suspender

**Al suspender se da de baja la suscripción del webhook en el proveedor.** La alternativa —recibir y descartar— es peor: rechazar webhooks provoca reintentos de Meta y, sostenido en el tiempo, **puede llevar a que Meta desactive nuestro webhook**, lo que afectaría a todos los clientes, no solo al moroso.

Reconectar al pagar es automático y no molesta al cliente: su token sigue cifrado en `channel_secrets`, así que no vuelve a autorizar nada. Es una ventaja que sale gratis de [[ADR-004-modelo-whatsapp]].

Consecuencia asumida: los mensajes que le escriban mientras está desconectado **no llegan nunca a la plataforma**. Quedan en su cuenta de WhatsApp, no en su bandeja. Es lo que hace Kommo.

`persisteEntrantesEnCrudo` sigue siendo `true` en todos los estados, pero ya solo cubre un caso de carrera: eventos que el proveedor tenía en vuelo cuando se dio de baja la suscripción. A esos se responde 200 y se guardan, porque devolver error solo genera reintentos.

## Bug de calendario que encontró un test

`finDePrueba` usaba `setMonth(getMonth() + 1)`. El 31 de enero más un mes da "31 de febrero", que JavaScript convierte en **3 de marzo**: tres días de prueba regalados a todo el que se registre a fin de mes. Además usaba hora local en un sistema que es UTC en todo lo demás. Corregido recortando al último día del mes destino, con tests de bisiesto y cruce de año.

## Pendiente

- **P-21** qué medimos y cobramos. Con el costo de mensajería fuera ([[ADR-004-modelo-whatsapp]]), la IA es lo único que nos cuesta dinero de verdad.
- **P-10** proveedor de pagos. Stripe era referencia, no decisión.
- Los precios sembrados en la migración 0007 son marcador de posición.

## Factura o boleta, y el comprobante descargable (PR-87, 2026-09-21)

Primera mitad del punto 6. El hotel elige qué comprobante necesita por su suscripción al CRM, y lo descarga cuando lo subimos.

### Por qué factura Y boleta, y no «un comprobante»

En Perú no son lo mismo y no se eligen por gusto:

- **Factura**: para quien tiene RUC y va a usar el gasto como crédito fiscal. Exige RUC, razón social y dirección.
- **Boleta**: para persona natural. Basta el DNI —opcional por debajo de S/ 700— y no da crédito fiscal.

Un hotel formal querrá factura. Si el CRM manda boletas, ese gasto no se deduce. Preguntarlo una vez evita un problema mensual.

### El RUC se comprueba de verdad

`packages/core/src/facturacion.ts` valida el **dígito de control** por módulo 11, no solo la longitud. Un RUC mal tecleado no lo rechaza nadie hasta que SUNAT devuelve la factura, semanas después y con el crédito fiscal perdido. Esto atrapa el error más común —dos cifras cambiadas de sitio— al escribirlo.

No comprueba que el RUC **exista**: para eso haría falta preguntarle a SUNAT, que es una integración con su propia caducidad y su propio permiso.

El DNI se valida solo por longitud: lleva un carácter de verificación que **no está impreso en los documentos antiguos**, y exigirlo rechazaría a personas con su DNI en la mano.

### Pendiente no es lo mismo que retrasado

Cada pago dice el estado de su comprobante: `pendiente` mientras quedan horas, `retrasado` pasadas las 48, `disponible` cuando está. Lo segundo es un incumplimiento **nuestro**, y el hotel tiene derecho a verlo sin preguntar por WhatsApp. Sale en rojo.

El plazo se **calcula** desde que se registra el pago, no se guarda: un plazo guardado y un pago con la fecha corregida se separan, y entonces la pantalla promete algo que ya no es. Y se cuenta desde el registro, no desde lo que cubre — un pago de enero registrado en marzo no nace vencido.

## El primer cruce de inquilino: el operador de la plataforma

Subir el comprobante es lo único que alguien de fuera de una cuenta escribe dentro de ella. Vive en `apps/api/src/uso/operador.service.ts`, en su propio archivo y bajo `/v1/operador`, porque **un cruce de inquilino tiene que verse en cualquier búsqueda**.

Cuatro cierres, y cada uno haría falta aunque fallaran los otros:

1. **`users.is_operator`**, que no se activa desde la aplicación. Se pone por consola **con el superusuario**: `users` lleva RLS forzada y ni el dueño de la tabla la salta, así que un `UPDATE` desde la cuenta de la aplicación no toca ninguna fila **y no se queja**. Un botón de «hazme operador» sería un botón de «dame todas las cuentas».
2. **Se entra por la puerta**: el contexto se fija al inquilino de destino con `paraInquilino`, así que la RLS sigue aplicándose dentro. No se desactiva nada. Por eso un medio de otra cuenta simplemente no se encuentra, sin ninguna comprobación escrita a mano — que es la comprobación que alguien acaba olvidando.
3. **Permiso por COLUMNA.** En 0016 se le quitó a la aplicación toda escritura sobre `subscription_payments`: nadie puede declararse pagado. Esa regla se queda. Lo que se concede son las **tres columnas del comprobante**, con `GRANT UPDATE (col, col, col)`. El importe y las fechas siguen intocables.
4. **Auditoría en la cuenta del hotel**, con el usuario de plataforma que lo hizo. El hotel puede ver quién tocó su cuenta desde fuera.

Quien no es operador recibe **404, no 403**: un 403 le confirmaría que la ruta existe a quien la está buscando.

Lo que el operador **no** puede hacer: leer conversaciones, mensajes, contactos ni reservas.

### Lo que costó un rato

El test del operador daba 404 sin explicación. Dos causas encadenadas, las dos del mismo tipo —**no fallan, devuelven vacío**:

1. `UPDATE users SET is_operator = true` desde el rol dueño no tocaba ninguna fila: `users` lleva RLS **forzada**, que se aplica también al propietario de la tabla.
2. El fichero de test no pasaba `authDatabaseUrl`, así que la lectura de identidad caía al rol de inquilino, y la política que deja leer `users` es del rol de autenticación.

### Cómo comprobarlo en menos de 5 minutos

Ajustes → Suscripción. Cambia a **Factura**: aparecen RUC, razón social y dirección. Escribe un RUC con un dígito cambiado y guarda: lo rechaza diciendo por qué. Con uno bueno, se guarda. Abajo, cada pago dice si su comprobante está en camino, retrasado, o listo para descargar.

34 tests nuevos (14 del RUC y el plazo, 9 de API, 11 de pantalla). Comprobado además contra la API real: subir el PDF, adjuntarlo como operador y verlo disponible desde la cuenta del hotel.
