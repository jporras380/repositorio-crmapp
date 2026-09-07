---
estado: aceptado
fecha: 2026-09-07
modulo: canales
tags: [adr, whatsapp, meta, onboarding, facturacion, lista-de-parada]
---

# ADR-004 — Modelo de conexión a WhatsApp: BYO-credentials

Resuelve **P-01**. Decisión de la lista de parada: aprobada por el usuario el 2026-09-07.

## Contexto

Cuatro modelos posibles, evaluados con matriz ponderada y con Kommo como referencia empírica. El detalle completo de la evaluación está en [[2026-09-07]]; aquí queda lo que hay que recordar.

Lo que hizo decidible el criterio de reversión —el que más se subestima— fue que **Kommo probó el modelo alternativo y lo abandonó dejando el costo documentado**. Ver [[whatsapp]].

## Decisión

**BYO-credentials (opción D).** El cliente trae su propia WABA y su propio número; en el CRM introduce sus credenciales, que se guardan cifradas en `channel_secrets`. **Meta le factura a él, directamente.** Nosotros solo cobramos nuestra suscripción.

**Tech Provider con Embedded Signup (opción A) queda documentado como destino, no como compromiso.** No se construye ahora.

Lo que hace segura esta decisión: **D es un subconjunto estricto de A**. Mismo `channel_accounts`, mismo token cifrado por inquilino, misma relación de facturación. Añadir Embedded Signup más adelante es aditivo — no migra datos ni cambia el esquema. No es un camino distinto, es el mismo camino sin el tramo bonito de entrada.

## Costo de lo elegido

- **El onboarding manual no escala.** Fue el único punto donde D puntuó bajo (2/5 en mantenimiento) y es real: "¿de dónde saco el token?", tokens caducados, permisos mal configurados. Son tickets, y el tiempo de una sola persona es el recurso escaso. Aguanta unos pocos clientes, no decenas.
  **Mitigación:** guía de conexión paso a paso y un diagnóstico en la pantalla de integraciones que diga *qué* falta (token inválido, webhook sin suscribir, permiso ausente), no solo "error".
- **No libra del App Review.** Esto no es opinable y conviene tenerlo claro desde hoy: para recibir webhooks de la WABA de un cliente hace falta **nuestra** app de Meta, y servir a clientes sin rol en esa app exige **Acceso Avanzado** a `whatsapp_business_messaging` y `whatsapp_business_management`, que pasa por revisión. Lo que D compra es empezar ya, en modo desarrollo, con el cliente piloto añadido como tester, mientras la revisión corre en paralelo.
- **Filtra clientes.** Una micro-pyme que no sabe montar un Meta Business Portfolio no se puede incorporar sola. Es una restricción comercial, no técnica, y es la condición de revisión principal de este ADR.

## Alternativas descartadas

- **A · Tech Provider propio (Embedded Signup).** No descartada: aplazada. Es el destino. Puntuó 90 frente a 99 de D, y la única diferencia entre ambas es *cuándo* se construye el flujo de alta.
- **B · Solution Partner / BSP con saldo prepago (53).** Nos convierte en intermediario financiero de Meta y añade un módulo de wallet completo —recargas, saldo insuficiente, reembolsos, conciliación— que no está en ninguna fase. Y la salida está tarifada: cuando Kommo migró desde este modelo, **las automatizaciones de los clientes se reiniciaron y hubo que reconfigurarlas**. Revertir rompe los Salesbots, que son el módulo 6.3.
  *Habría ganado* si hubiera un cliente firmado esperando y el App Review se alargara — como puente temporal, con contrato de salida escrito.
- **C · WABA compartida nuestra (39).** El modo de fallo es colectivo: un cliente agresivo degrada la calidad del número de todos y Meta penaliza el patrón como spam. Además el número no se puede cambiar después, porque es el que los clientes finales tienen guardado.
- **WhatsApp no oficial (QR / WhatsApp Web).** Descartada sin evaluar: viola los términos y es baneable.

## Consecuencias

1. **P-02 sale de la lista de parada.** Si el cliente paga a Meta directamente no hay costo que repercutir ni que absorber. Se elimina el módulo de wallet del roadmap.
2. **`usage_events` se simplifica** a asientos y consumo de IA — lo único donde le pagamos a un proveedor. Referencia de Kommo en [[whatsapp]].
3. **El adaptador expone capacidades, no asume el modelo.** `channel_accounts` guarda el `waba_id` y el `phone_number_id` del cliente igual en D que en A.
4. **El modo sandbox del adaptador sigue siendo de fase 0**, sin cambios: el riesgo principal del proyecto sigue siendo la espera del Acceso Avanzado.

## Cómo se revierte

Hacia A: gratis, es aditivo. Hacia B: caro y con precedente medido. **El punto de no retorno es el primer cliente con volumen real**: a partir de ahí, cambiar de modelo significa migrar números productivos.

## Señales de revisión

- Si el onboarding manual genera más de ~2 h de soporte por alta, construir Embedded Signup (opción A). Es la señal esperada, no un fallo.
- Si el mercado objetivo resulta ser micro-pymes que no montan su propio portafolio (depende de **P-05**), A pasa de destino a requisito de venta.
- Si el Acceso Avanzado se alarga más de ~8 semanas con un cliente firmado esperando, reconsiderar B **solo como puente**, con salida escrita.
