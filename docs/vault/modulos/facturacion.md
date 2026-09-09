---
estado: vivo
fecha: 2026-09-09
modulo: facturacion
tags: [facturacion, suscripciones, prueba, gracia, entitlements]
---

# Módulo — Facturación y ciclo de vida de la cuenta

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
