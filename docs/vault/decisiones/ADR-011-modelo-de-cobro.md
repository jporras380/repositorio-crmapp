---
estado: aceptado
fecha: 2026-09-10
modulo: facturacion
tags: [adr, facturacion, precios, asientos, kommo]
---

# ADR-011 — Modelo de cobro: suscripción por asiento, cobro manual, mensajería fuera

## Contexto

Fase 4 pide «se puede cobrar» y hasta hoy no se podía decidir: P-02 (quién asume el coste de mensajería de Meta), P-10 (proveedor de pagos) y P-21 (qué se cobra) estaban en la lista de parada del usuario.

El usuario resolvió P-02 con una instrucción de una línea: **«hazlo como lo hace Kommo o Zenvia»**. Eso no es una tercera opción entre las que se le ofrecieron —incluir, prepago o postpago— sino una cuarta que las anula, y la evidencia ya estaba en el vault desde el 2026-09-07 ([[whatsapp]] §Aprendizajes de terceros):

- Kommo es Tech Partner de Meta: el cliente crea su propio WABA y **añade su método de pago a su propia cuenta de Meta**. Kommo **no factura el consumo de mensajería**.
- Kommo probó el modelo contrario —saldo prepago recargable— y **lo abandonó** el 2024-10-01.
- Su estructura comercial es **por asiento** ($25/$35/$45 por usuario/mes) y **la IA es el único consumo medido**, con packs de créditos. Contactos, leads y campos son límites de plan, no consumo facturado.

Zenvia es otra cosa: es BSP, revende mensajería con margen y por eso necesita monedero. Copiar a Zenvia significaría convertirnos en intermediario financiero de Meta, que es justamente lo que [[ADR-004-modelo-whatsapp]] descartó.

## Decisión

**1. La mensajería de Meta no pasa por nosotros.** El cliente conecta su propio WABA con su propio método de pago; Meta le factura a él. No la absorbemos, no la revendemos, no la conciliamos. Es la consecuencia natural del BYO-credentials de ADR-004 y es lo que hace Kommo hoy.

**2. Cobramos suscripción por asiento.** El precio del plan es **por usuario y mes**; el importe mensual son los miembros activos por el precio del plan. `plans.limits.agentes` deja de ser un número decorativo: es el techo de asientos del plan, y pasarlo obliga a subir de plan.

**Los asientos no se guardan, se cuentan.** Nada de una columna `seats` que hay que mantener sincronizada con `memberships` y que un día dirá que se cobran cinco asientos a una cuenta que tiene dos. El importe se calcula al mirarlo, de la misma fuente que la lista de usuarios.

**3. El cobro es manual: transferencia y factura.** Decisión del usuario, y la correcta para un producto sin clientes todavía: cero desarrollo, cero coste recurrente, cero dependencia de una pasarela. (Contexto que la hace más razonable: Stripe no admite empresas de Perú, así que la alternativa habría sido Culqi, Mercado Pago o un *merchant of record* con su comisión.)

**El operador registra el pago, no el cliente.** El cobro manual crea un riesgo obvio —que un inquilino se marque a sí mismo como pagado— y se cierra por permisos, no por buena fe: `subscription_payments` es de **solo lectura para el rol de la aplicación**, y quien inserta es el script del operador con el rol de migración. No hay backoffice, no hay superusuario, no hay superficie nueva que proteger.

**4. Pasarse de un límite avisa; solo se corta lo que consumimos nosotros.** Nunca se bloquean las conversaciones entrantes: dejar a un cliente sin recibir los mensajes de SUS clientes es el peor daño que le podemos hacer y no lo arregla ningún cobro. Se cortan los bots (y la IA, en fase 5), que sí son trabajo nuestro. Aviso al 80 % y al 100 % en «Uso del plan».

## Costo de lo elegido

- **El cobro manual no escala.** Con veinte clientes es un rato al mes; con doscientos es un trabajo. La señal para revisarlo es esa, no una fecha.
- **No hay ingreso por mensajería.** Un BSP gana margen en cada plantilla; nosotros no. A cambio no tenemos monedero, ni conciliación, ni el riesgo de que un cliente nos deba dinero de mensajes ya enviados.
- **Por asiento castiga a las cuentas con muchos agentes de poco uso** y regala volumen a las de pocos agentes muy activos. Es el modelo que el mercado de CRM entiende, y por eso se acepta.

## Alternativas descartadas

- **Prepago con monedero (Zenvia).** Nos vuelve intermediario financiero de Meta y añade un módulo entero que no está en ninguna fase. Kommo lo probó y lo abandonó, con la salida documentada: al migrar, **las automatizaciones de los clientes se reiniciaron**.
- **Postpago medido de mensajería.** Exige conciliar nuestro conteo con el de Meta y defender la diferencia delante del cliente cada mes.
- **Pasarela desde el día uno.** Integración, webhooks y comisiones para cobrar a cero clientes.

## Cómo se revierte

Es la decisión más reversible de todas las tomadas: los pagos son filas, el precio se calcula al vuelo y no hay estado externo que migrar. Añadir una pasarela después es añadir un origen más a `subscription_payments`, no cambiar el modelo.

## Señal de revisión

Cuando registrar pagos a mano deje de caber en una mañana al mes, o cuando un cliente pida factura automática. Para la mensajería: si alguna vez nos hacemos BSP, esta decisión cae entera y con ella ADR-004.
