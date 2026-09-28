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

## La consola del operador (PR-88, 2026-09-21)

Segunda mitad del punto 6. Todas las cuentas de la plataforma en una tabla, ordenadas por lo que hay que atender hoy.

Contesta tres preguntas, en este orden:

1. **¿A quién le debo un comprobante?** Es lo único con un plazo legal encima —48 horas—, y por eso manda el orden de la tabla y sale un aviso arriba sin tener que contar filas.
2. **¿A quién se le vence?** Lo segundo que decide a quién se llama.
3. **¿Qué cuenta se está quedando muda?** Un canal caído, o cero mensajes en el mes, es un cliente que se va sin avisar.

### El rol, que es la decisión de verdad

Leer todas las cuentas a la vez es, por definición, atravesar el aislamiento que sostiene el producto. Migración 0040: **un rol de base de datos**, `crmapp_operador`.

**Por qué un rol y no una bandera de sesión.** La alternativa era «si `app.operador` está puesto, deja leerlo todo», y es frágil: cualquier camino que consiga ejecutar un `set_config` desbloquea la base entera. Un rol no se cambia desde dentro de una consulta. Es el patrón que ya usaban el rol de autenticación (0008) y el del relay (0006); esto lo sigue en vez de inventar otro.

**Por qué no `BYPASSRLS`.** Se aplicaría a toda la base y para siempre. Aquí el escape son políticas nombradas sobre una lista corta de tablas: facturación, suscripciones, pagos, consumo y estado de canales. Lo que no esté en esa migración, el operador no lo ve, y añadir una tabla es un cambio que se lee en una revisión.

**Y es de solo lectura.** Si alguien encadenara una inyección hasta este rol, podría contar cuentas ajenas, no tocarlas. Lo único que el operador escribe —el comprobante de un pago (0039)— pasa por el rol de aplicación entrando en el contexto del inquilino.

Dos tests lo comprueban **contra la base de datos, no contra la API**: que el rol recibe `permission denied` al leer `conversations`, `messages` y `contacts`, y al intentar escribir lo que sí puede leer. Así sigue siendo verdad aunque mañana alguien escriba una consulta nueva en la consola.

La respuesta de la API se fija con **lista blanca de campos**, no con lista negra de palabras: buscar «mensaje» en el JSON es burdo —`mensajesDelMes` es un contador y la contiene— y además no protege de un campo nuevo con otro nombre.

### Por qué una consulta y no una por inquilino

Recorrer inquilinos entrando en el contexto de cada uno habría mantenido la RLS de siempre, pero son cinco consultas por cuenta: con cien cuentas, quinientas idas y vueltas para pintar una tabla. El rol existe justo para evitarlo.

### El fallo que encontró una captura

La celda de estado decía **«vence »** y nada detrás. `hace()` solo sabe de tiempos pasados y devuelve `null` con cualquier fecha futura. Hacía falta su gemela, `faltan()`, que además cuenta **días de calendario** y no horas: a las once de la noche, «en 1 día» y «mañana» son la misma fecha, pero solo una organiza el trabajo de quien la lee.

Ningún test lo habría visto: los tests miran el DOM y ahí el texto estaba: «vence» seguido de nada.

### Cómo comprobarlo en menos de 5 minutos

Actívate como operador (comando en 0039) y aparece un icono de edificios en el riel. La consola ordena por deuda de comprobante y marca en rojo lo que pide una llamada.

15 tests nuevos (6 de API —dos de ellos contra la base—, 9 de pantalla, 5 de `faltan()`).

## Modo soporte: el cliente deja entrar, y solo un rato (PR-90, 2026-09-21)

La consola del operador (0040) ve cifras de todas las cuentas y ni una conversación. Eso es lo que la hace defendible. Pero cuando un cliente escribe «no me llegan los mensajes», mirar cifras no alcanza: hay que ver su bandeja, y eso son conversaciones de huéspedes.

El usuario lo pidió con sus condiciones, y son las cuatro que se implementaron.

### 1. Lo autoriza el cliente

El operador **pide** diciendo para qué; alguien de la cuenta **abre**. El motivo es obligatorio y largo: «necesito entrar» no es algo que el cliente pueda valorar, y es lo único que tiene para decidir.

Que el operador no pueda aprobarse a sí mismo **no lo garantiza el código**: su rol de base de datos tiene `INSERT` sobre `support_grants` con un `WITH CHECK` que exige `approved_by IS NULL`, y no tiene `UPDATE`. Hay un test que lo comprueba contra PostgreSQL. Un permiso que uno se da solo es una llave maestra.

### 2. Caduca solo

El plazo lo fija **quien abre la puerta**, no quien llama: 1, 4, 8 o 24 horas, en cuatro botones. Un campo vacío invita a escribir 999. Se puede cerrar antes en cualquier momento, y ese mismo botón sirve para rechazar.

### 3. Solo lectura, garantizado por PostgreSQL

El rol `crmapp_soporte` **no tiene INSERT, UPDATE ni DELETE sobre nada**. Un soporte que puede escribir puede romper, y entonces nadie sabe si el fallo era del cliente o de quien fue a ayudarle.

Tampoco hizo falta escribir políticas nuevas: `tenant_isolation` (0001) no lleva cláusula `TO`, así que se aplica a cualquier rol. Al de soporte le basta el `GRANT SELECT` y queda encerrado en el inquilino del contexto. Hay un test que lo demuestra: con ese rol y **sin** inquilino puesto, `SELECT FROM conversations` devuelve cero filas.

Y si `DATABASE_SOPORTE_URL` no está configurada, el servicio **se niega a funcionar** en vez de caer al rol que sí escribe. Fallar cerrado.

### 4. Queda en la auditoría del cliente

`soporte.solicitado`, `soporte.aprobado`, `soporte.revocado`, con quién y cuándo. La pantalla enseña también los accesos pasados, y distingue los que **nunca se abrieron**: el valor del registro está en poder mirarlo sin preguntarle a nadie.

### Lo que se ve al entrar

No es la bandeja: es la lista de lo que falla. Siete campos por conversación —canal, estado, últimas fechas, mensajes fallidos y el último error— porque «no me llega» y «no se envía» se contestan con eso, no leyendo lo que la gente se dice. Un test fija esos campos con lista blanca.

## La guarda que salió de aquí: clases de CSS que no existen

La primera captura de la pantalla de soporte salió con viñetas y sin estilo. El componente usaba cinco clases que vivían en la hoja de **otra** pantalla, porque el nombre encajaba. `estilos.sesiones` sobre una hoja que no la declara devuelve `undefined`, React pinta `class="undefined"` y el bloque sale desnudo. **No falla, no avisa.**

Es la misma familia que los tokens de CSS inexistentes (PR-84), un nivel más arriba, así que `check-puertas.mjs` la vigila ahora también. Encontró **tres casos que ya estaban en el repositorio**:

- `MapaDelFlujo`: una clase en el `<g>` de las aristas que no pintaba nada. Sobraba; se quitó.
- `Hilo`: `.estado` no existía, así que **el estado de entrega de un mensaje saliente no tenía estilo propio** y un «No se envió» se veía igual que un «Leído». Ahora existe, y el fallo va en rojo.
- `Informe`: falso positivo mío. `.num` está declarada como `.tabla .num`, y mi patrón solo leía la primera clase de cada línea. Corregido para leer el selector entero.

Detalle de implementación que costó un rato: las expresiones regulares de esa guarda van **sin una sola barra invertida**, con clases de caracteres. Escribirlas con `\b` o `\w` las dejaba mutiladas al pasar por las capas de comillas del shell, y el resultado era una guarda que no encontraba nada y parecía funcionar.

### Cómo comprobarlo en menos de 5 minutos

Actívate como operador, pide acceso a una cuenta desde la API, y entra en esa cuenta → Ajustes → Acceso de soporte. Verás quién pide y por qué. Antes de abrir, la consulta de soporte devuelve 403; al abrir, 200; al cerrar, 403 otra vez.

22 tests nuevos (12 de API —cuatro contra la base— y 10 de pantalla).

## Chat con soporte técnico (PR-91, 2026-09-21)

Cierra el círculo del modo soporte: por aquí llega el «no me llegan los mensajes» que justifica pedir el acceso.

### Qué reemplaza, y por qué importa

Hoy un cliente con un problema escribe por WhatsApp a un número personal. Eso tiene tres consecuencias que se pagan más tarde: el historial se pierde, nadie del equipo sabe qué se respondió, y **quien atiende no tiene delante ni el plan ni el estado de los canales de esa cuenta**. En la consola, el hilo se abre debajo de la tabla —no en una ventana— justo para que eso siga a la vista mientras se responde.

### Un hilo por cuenta, no tickets

Un sistema de tickets pide categorías, prioridades, estados y alguien que los mantenga. Para un producto con tres clientes eso es ceremonia. Un hilo continuo —como hablar por WhatsApp, que es lo que ya hacen— resuelve el 100 % de los casos de hoy, y el día que no baste, los mensajes ya están guardados y se pueden agrupar.

### Por qué NO reutiliza `conversations`

Esa tabla es la correspondencia con los **huéspedes**: la mira la bandeja, cuenta para los topes del plan, la tocan los bots y la gobierna la ventana de 24 horas de Meta. Meter aquí los mensajes a soporte ensuciaría las cifras que el cliente usa para saber cuánto consume, y un bot podría acabar respondiéndole a soporte. Hay un test que comprueba que escribir a soporte **no crea ninguna conversación**.

### Decisiones pequeñas que se notan

- **Cualquiera del equipo puede escribir.** El que se topa con el problema es quien lo cuenta; obligar a avisar al dueño solo garantiza que no se reporte.
- **Abrir el hilo SÍ lo marca como leído** — lo contrario que la bandeja (PR-83), y a propósito: allí «leído» es una decisión sobre el trabajo de un equipo, y aquí es tu propia conversación con quien te vende el producto.
- **Sin contador guardado.** El «sin leer» se cuenta de `read_at IS NULL`, porque un contador es lo que se desincroniza.
- **La consola ordena primero a quien espera respuesta**, antes que a quien espera comprobante: un cliente escribiendo está parado y no sabe si le han leído.
- **Responder no exige permiso de soporte.** Contestar a quien te escribió no es entrar en su casa.
- **El mismo componente sirve para los dos lados**, con `tenantId` invirtiéndolos. Hay dos tests solo para eso: sin ellos, el operador vería sus propias respuestas como si las hubiera escrito el cliente.

### La lista blanca hizo su trabajo

Añadir `soporteSinLeer` a la consola rompió el test que fija los campos exactos de esa respuesta (PR-88). Es justo para lo que está: un campo nuevo en una pantalla que cruza el aislamiento entre cuentas tiene que declararse a propósito, no colarse.

### Cómo comprobarlo en menos de 5 minutos

Ajustes → Soporte técnico: escribe algo. En la consola del operador aparece «1 cuenta espera respuesta» arriba y «1 sin leer» en rojo en su fila. Pulsa ahí, responde, y el cliente lo ve en su hilo sin que nadie se lo reenvíe.

21 tests nuevos (10 de API, 11 de pantalla).

## Capturas en el chat (PR-93, 2026-09-23)

Lo pidió el usuario con sus palabras: «que pueda enviar foto o vídeo en caso el usuario interactua con el soporte le pida esa información de que sucede en su CRM».

«No me sale el botón» y una captura del botón que no sale son la misma frase, pero solo una se entiende a la primera.

### Por qué reutiliza `media_assets` y no una tubería nueva

Ya existe todo: subida por URL firmada sin que los bytes pasen por la API, deduplicación por `sha256`, límite de tamaño, lista de tipos admitidos y descarga firmada de vida corta. Una segunda tubería para soporte sería mantener dos, y la segunda no tendría **ninguna** de esas cosas hasta que a alguien le tocara añadírselas.

El medio es del **inquilino**, como cualquier otro. Que soporte pueda verlo es un permiso aparte y acotado, no una propiedad del archivo.

### La decisión que sostiene la consola

El cliente ve sus propias capturas por `/v1/medios/:id/url`, que RLS ya le resuelve. El operador **no puede** usar esa ruta: su contexto de sesión es su propio inquilino, no el del cliente.

La tentación era darle una ruta que firmara cualquier `mediaAssetId` de cualquier cuenta. Eso habría roto en silencio la promesa que hace defendible toda la consola —**el operador no ve conversaciones de huéspedes**—, porque una foto de la bandeja es exactamente eso.

Por eso `urlDeAdjunto` exige que el medio **cuelgue de un mensaje de soporte de esa cuenta**, con el `JOIN` dentro de la propia consulta:

```sql
FROM media_assets a
JOIN support_messages m ON m.media_asset_id = a.id
WHERE a.id = $1 AND m.tenant_id = $2
```

Un medio ajeno al hilo y uno inexistente se contestan igual (404): quien pregunta no averigua si el identificador existe en otra parte. Hay un test que crea un medio **de la misma cuenta** pero no adjunto, y comprueba que el operador recibe 404. Si alguien quitara ese `JOIN`, ese test se pone rojo.

### El adjunto se valida en el INSERT, no antes

```sql
INSERT INTO support_messages (...)
SELECT $1, $2, $3, $4, $5::uuid
 WHERE $5::uuid IS NULL
    OR EXISTS (SELECT 1 FROM media_assets a
                WHERE a.id = $5::uuid AND a.tenant_id = $1 AND a.status = 'stored')
```

Comprobarlo antes en una consulta aparte dejaría un hueco entre la comprobación y la escritura, y sobre todo dejaría la garantía en el código en vez de en la base. Cero filas devueltas es «esa captura no es tuya o no está subida», y se responde 409.

### Decisiones pequeñas

- **El cuerpo deja de ser obligatorio cuando hay adjunto.** Mandar una captura sin texto es una forma legítima de decir «mira esto»; obligar a escribir algo solo produce mensajes que dicen «.». La reversa de 0044 rellena esos cuerpos con `(captura adjunta)` antes de volver a exigirlo.
- **Adjunta el cliente, no soporte.** Quien tiene el problema delante es él. Cuanto menos escriba soporte en la cuenta de un cliente, menos hay que explicar después.
- **Se sube al elegir el archivo, no al enviar.** Un vídeo de 8 MB por datos móviles convertiría «Enviar» en un botón que parece colgado.
- **El adjunto elegido se ve antes de enviarlo, y se puede quitar.** Uno que no se ve hasta después es un adjunto que se manda sin querer.
- **La URL se pide al pintar y caduca a los 5 minutos**, así que no se puede guardar en el mensaje ni reenviar por ahí.

### Lo que encontró la captura de pantalla

La primera salió con la burbuja del adjunto **vacía**. No era el código: el PNG que había sembrado para la prueba era de 1×1 píxel, y `max-inline-size: 100%` no agranda nada. Con una imagen de tamaño real se ve como debe. Vale la pena anotarlo porque el reflejo era ir a depurar el componente.

### Cómo comprobarlo en menos de 5 minutos

1. Ajustes → Soporte técnico → **Adjuntar**, elige una captura. Aparece su nombre encima del compositor con un «Quitar».
2. **Enviar** sin escribir nada: la captura sale en el hilo.
3. Desde la consola del operador, abre el hilo de esa cuenta: la misma captura se ve, firmada por la ruta acotada.
4. Con `curl`, pide `/v1/operador/soporte/<cuenta>/adjuntos/<un medio de la bandeja>`: **404**.

![Captura en el hilo de soporte](../adjuntos/2026-09-23-soporte-captura.png)

16 tests nuevos (7 de API —contra PostgreSQL— y 9 de pantalla).

## La consola, utilizable (PR-95, 2026-09-23)

Lo señaló el usuario preguntando por *«el apartado donde vea todos los CRM de los clientes y administrarlos»*. Existía desde PR-88, y **solo miraba**.

### Tres funciones entregadas y sin un botón

| Lo que había | Lo que faltaba |
|---|---|
| La tabla decía «3 comprobantes sin subir» | Forma de subir ninguno |
| El cliente podía **aprobar** un acceso de soporte | Forma de **pedirlo**: se arrancaba con `curl` |
| Con el permiso vivo, la API decía qué falla | Pantalla que lo enseñara |

Ninguna la encontró una revisión: las encontró la guarda 5 de PR-94. La segunda es la que peor pinta tiene: el modo soporte estaba **entregado, probado contra PostgreSQL y documentado**, y no se podía usar desde el producto.

### Por qué un detalle aparte y no más columnas

Para subir un comprobante hace falta saber **qué pagos** son, y la tabla solo lleva el recuento. Meterlos en ella la convertiría en una consulta por fila —hoy es una sola para todas las cuentas— y rompería el test de lista blanca que fija sus campos exactos, que está ahí justo para que una pantalla que cruza el aislamiento no crezca sola.

Así que `GET /v1/operador/cuentas/:tenantId` devuelve dos cosas: los pagos sin comprobante y el acceso de soporte que haya. Corre con el **rol del operador**, igual que la tabla, y hay un test que fija sus claves exactas y que comprueba que ese rol sigue sin poder leer `messages`. Si alguien lo cambiara al rol de la aplicación «para que sea más fácil», se pone rojo.

### Decisiones pequeñas

- **El plazo va en cada pago, no en un aviso general.** «Fuera de plazo» es un incumplimiento nuestro con **ese** pago, y saber cuál es lo que permite hacer algo. No dice «vencido» a secas porque en un pago de cliente eso significa lo contrario.
- **Pedir acceso exige un motivo de diez caracteres**, igual que la API. Lo lee el cliente antes de decidir y es lo único que tiene.
- **Pedido y sin abrir no ofrece reintentar.** La decisión es del cliente; insistir desde aquí solo crea solicitudes duplicadas.
- **Subir un comprobante recarga la tabla.** Dejarla diciendo «1 sin subir» después de subirlo es mentir en pantalla.
- **La ficha es enlazable**: `#operador/<tenantId>`. «Mírale esto a esta cuenta» deja de ser «entra en la consola y busca Barranca en la lista».

### La línea que sigue sin cruzarse

Ni con el permiso concedido se ve una conversación. Lo que devuelve «qué está fallando» son canales, estados y errores de envío —lo que contesta «no me llega»— y no cuerpos de mensaje. Eso no lo promete esta pantalla: lo impide el rol de base de datos, y hay un test que lo comprueba **contra la base**.

### Cómo comprobarlo en menos de 5 minutos

1. Entra en `#operador` y pulsa **Ver hilo** en una cuenta. Se abre su ficha debajo de la tabla, y la URL cambia a `#operador/<id>`.
2. Si le debes comprobantes, salen uno a uno con su importe y su plazo. Uno pasado de 48 h sale en rojo como **fuera de plazo**.
3. **Subir comprobante** → elige el archivo. La tabla de arriba se actualiza sola.
4. Escribe un motivo y **Pedir acceso**. Entra en esa cuenta como dueño → Ajustes → Soporte técnico: ahí está la solicitud con su motivo.
5. Ábrela 1 hora. Vuelve a la consola: **Ver qué está fallando** lista canales y errores, sin un solo mensaje de huésped.

![La consola con una cuenta abierta](../adjuntos/2026-09-23-consola-cuenta.png)

18 tests nuevos (8 de API —contra PostgreSQL— y 10 de pantalla).

## Cómo te pagan (PR-104, 2026-09-28)

Lo preguntó el usuario con una frase que no dejaba escapatoria: *«cuando el usuario quiera continuar usando el CRM, ¿en qué apartado está la opción de que me paguen? Ni número de cuenta ni QR ni Yape te he pasado»*.

La respuesta era que **ese apartado no existía**.

### Lo que decía la pantalla

> Los pagos se hacen por transferencia y los registramos nosotros al recibirlos.

Y en ningún sitio decía **a dónde**. El cliente leía eso y tenía que escribir para preguntar.

Yape y Plin sí estaban en el código —para que el hotel cobre a sus huéspedes en una reserva— que es justo lo secundario.

### La mitad manual del cobro manual

ADR-011 decidió cobro manual, sin pasarela. Eso sigue en pie y no se toca. Lo que faltaba **no era una pasarela**: era decir los datos. Se construyó la mitad que registra el dinero y no la que lo pide.

Es la misma familia que lleva toda la semana apareciendo —lo que existe y nadie puede usar— pero por el lado del negocio en vez del código.

### Declarar no es pagar

`payment_claims` es una tabla aparte de `subscription_payments` a propósito.

`subscription_payments` es el libro del dinero cobrado: lo lee el estado de la suscripción y decide si la cuenta sigue viva. **El cliente no escribe en el libro.** Declara —«ya pagué, aquí está el voucher»— y el operador confirma.

Si se mezclaran, cualquiera se daría por pagado.

Al confirmar hace falta escribir en el libro, y ahí apareció un límite del diseño que estaba bien puesto: el rol de la aplicación **no tiene INSERT** sobre `subscription_payments`, desde 0007. La salida no fue un `GRANT`:

- Un `GRANT INSERT` daría permiso para escribir **cualquier** pago, de cualquier importe, a cualquier cuenta.
- `app.confirmar_pago_declarado` es `SECURITY DEFINER`: el operador no gana el permiso, gana poder llamarla. El importe, la moneda y el método salen de **lo que declaró el cliente**, no de parámetros, así que nadie confirma por un sol un pago de mil. Y solo actúa sobre una declaración `pendiente`, así que confirmar dos veces no duplica el cobro.

Mismo patrón y mismo motivo que la purga de retención (0047).

### Lo que encontró un test, no un cliente

`subscription_payments.method` admitía transferencia, efectivo, tarjeta y otro. **No conocía Yape ni Plin**, porque en 0007 los pagos los tecleaba el operador y nadie echó en falta las dos formas con las que de verdad se paga en Perú. Confirmar una declaración hecha por Yape reventaba contra el CHECK.

La reversa de 0048 pasa esos pagos a `otro` antes de devolver el CHECK a como estaba: si no, la propia reversa fallaría contra las filas que ella permitió crear.

### Decisiones

- **Los datos se escriben en la consola del operador**, no en el `.env`. Cambiar un número de Yape no debería exigir tocar el servidor y reiniciarlo, y así queda quién lo cambió.
- **El importe en soles se fija a mano, por plan.** Los planes están en dólares y Yape cobra en soles. Un tipo de cambio automático es un servicio externo de coste recurrente y un número que se mueve solo el día que a alguien le cobran de más.
- **Lo que no se carga, no se enseña.** Sin datos, la pantalla dice que faltan en vez de pintar una tarjeta con campos vacíos: no promete un método que no existe.
- **El botón dice «Avisar de que ya pagué», no «Pagar».** Aquí no se cobra nada, y prometer un cobro que no ocurre es peor que no ofrecerlo.
- **Rechazar exige un motivo.** El cliente lo va a leer, y un rechazo mudo le obliga a escribir para preguntar — que es lo que esto viene a evitar.
- **El QR se firma y caduca.** Un `<img>` no manda la cabecera de sesión, así que la URL se pide antes, igual que las capturas del chat de soporte (0044).

### La guarda volvió a fallar por lo mismo

`peticion<(A & B)[]>` rompió el patrón de la guarda de rutas: su paréntesis se adelanta al que abre la llamada. Es la **segunda vez** que ese anclaje falla al crecer un genérico —la primera fue `peticion<Pagina<X>>`—, y las dos veces se equivocó sobre una ruta que sí se pedía, que es como se enseña a ignorar una guarda.

Ahora busca las rutas directamente: una cadena que empiece por `/v1/` en el cliente web es una ruta y punto. Comprobado al revés: renombrando una, se pone roja.

### Cómo comprobarlo en menos de 5 minutos

1. Consola del operador → **A dónde te pagan**. Escribe tu banco, cuenta, CCI y Yape. Sube el QR. Pon el importe en soles de cada plan.
2. Entra como cliente → Ajustes → Suscripción. Ahí están los datos, con el QR y el importe en soles al lado del de dólares.
3. **Avisar de que ya pagué** → método, fecha, número de operación y el voucher adjunto.
4. Vuelve a la consola: sale arriba, en verde. **Confirmar** crea el pago y aparece en el historial del cliente. **Rechazar** te pide el motivo, y el cliente lo lee.

![Cómo pagar, visto por el cliente](../adjuntos/2026-09-28-como-pagar.png)

![Dónde se cargan los datos](../adjuntos/2026-09-28-datos-de-cobro.png)

25 tests nuevos (9 de API —contra PostgreSQL— y 16 de pantalla).

## El plazo: por cuántos meses se contrata (PR-105, 2026-09-28)

La segunda mitad de la pregunta del usuario: *«¿en qué apartado está la opción de por cuántos meses lo está adquiriendo, 1, 3, 6 o 1 año, y si es un año darle alguna promoción?»*.

Tampoco existía. `subscriptions` tenía `current_period_ends_at` y **ningún concepto de plazo**: el periodo era mensual porque sí.

### Esto toca el modelo de cobro, que estaba en la lista de no tocar

Queda escrito en la migración 0049 y aquí. Se hizo porque lo pidió el dueño del producto, no porque pareciera buena idea.

Lo que **no** cambia: se sigue cobrando por asiento ocupado, los asientos se siguen contando al mirar en vez de guardarse, y el cobro sigue siendo manual. El plazo solo dice **cuántos meses se pagan de una vez**.

### Un año se paga a once

Lo eligió el dueño entre cuatro opciones. Los plazos cortos **no llevan descuento** a propósito: lo que se premia es comprometerse un año, y repartir el descuento entre todos los plazos es regalarlo a quien iba a pagar igual.

La regla vive en una sola línea de `packages/core`:

```ts
export function mesesQueSeCobran(plazo: Plazo): number {
  return plazo === 12 ? 11 : plazo;
}
```

Cambiarla no es buscarla por cuatro archivos.

### El error que estuve a punto de cometer

Escribí el selector del alta importando `precioDelPlazo` desde `@crmapp/core` en `apps/web`. Compiló mal —`core` no es dependencia de la web— y al mirar por qué apareció algo mejor: **la web no ha importado `core` ni una sola vez** en todo el proyecto. No es casualidad; está escrito en la cabecera de `tipos.ts`:

> Las formas que devuelve la API, tal cual. La web no las interpreta: las pinta. Si algo aquí necesitara una regla de negocio, esa regla va a la API.

«Un año se paga a once» es una regla de negocio. Si la calculara la pantalla, el día que cambie el descuento habría **dos verdades**.

Así que `GET /v1/planes` devuelve ahora el precio de cada plazo ya calculado, y la web solo lo pinta. El fallo de compilación fue el que hizo la pregunta correcta.

### Decisiones pequeñas

- **Cuatro valores, no un número libre.** Un campo libre invita a escribir 7, y entonces hay que decidir qué descuento lleva un plazo que nadie pensó. El CHECK obliga a que ampliar la lista sea una decisión.
- **El ahorro se enseña en dinero, no en porcentaje.** «8 %» obliga a calcular; «te ahorras 25 USD» se entiende sin hacer nada.
- **Cambiar el plazo no toca lo ya pagado.** Dice cuánto se paga la *próxima* vez, y eso se decide antes de pagar. Hay un test de que `periodoHasta` no se mueve.
- **El plazo se guarda desde el alta**, aunque la prueba todavía no cobre: es lo que el cliente eligió y lo que se le cobrará al terminar.

### Cómo comprobarlo en menos de 5 minutos

1. `#alta` → elige un plan. Debajo de la contraseña salen los cuatro plazos.
2. Pulsa **Un año**: dice «Pagas 11 meses y usas 12: te ahorras 25 USD por asiento».
3. Pulsa **3 meses**: ya no promete ahorro, porque no lo hay.
4. Crea la cuenta y entra en Ajustes → Suscripción: el plazo elegido está puesto, y se puede cambiar sin tocar lo cubierto.

![El plazo, en Suscripción](../adjuntos/2026-09-28-plazo.png)

16 tests nuevos (7 de API —contra PostgreSQL—, 5 de dominio y 4 de pantalla).
