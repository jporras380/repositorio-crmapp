---
estado: vivo
fecha: 2026-09-07
modulo: meta
tags: [preguntas, bloqueantes, descubrimiento]
---

# Preguntas abiertas

Ordenadas por urgencia. **Bloqueante** significa que el ARCH no se escribe sin la respuesta. Las marcadas *(lista de parada)* corresponden a la sección 9 del prompt maestro: no decido solo aunque tenga opinión.

## Bloqueantes

### P-01 · Modelo de WhatsApp *(lista de parada)*
Tech Provider propio con Embedded Signup, vía BSP (360dialog, Twilio, Gupshup), o WABA compartida nuestra. Decide `channel_accounts`, el onboarding entero y quién paga a Meta.
**Estado:** el usuario respondió "aún no decidido" el 2026-09-07. El adaptador se diseña para los tres, pero el ARCH necesita saber cuál es el camino del MVP.
Detalle de los tres modelos en [[whatsapp]].

### P-02 · Repercutir o absorber el costo de mensajería *(lista de parada)*
Meta cobra por plantilla entregada, con tarifa por país y por categoría — y la categoría efectiva la fija Meta, no nosotros.
- **(a) Absorbido**, incluido en el plan. Simple de vender, margen impredecible: un cliente que envía marketing en un país caro se come el plan.
- **(b) Saldo prepago** que el cliente recarga. Protege el margen y es lo que hacen los competidores; añade un módulo de wallet entero (recargas, saldo insuficiente, avisos, reembolsos).
- **(c) Postpago medido**, facturado con la suscripción. Justo, pero exige conciliar nuestro conteo con el de Meta y aguantar la discrepancia delante del cliente.

### P-03 · Qué cuenta como "conversación mensual"
A efectos del límite de plan: ¿la ventana de 24 h, o nuestro ciclo abrir/cerrar?

**Corregida el 2026-09-07.** La versión original de esta pregunta asumía que el cliente compararía nuestro conteo con su factura de Meta. Ya no aplica: desde el 1 de julio de 2025 **Meta factura por mensaje entregado, no por conversación**. Ver [[whatsapp]]. La pregunta sigue viva pero es solo de producto —qué límite de plan es justo y comprensible—, no de conciliación contable. Baja de bloqueante a menor si se aprueba el modelo Tech Provider de [[ADR-004-modelo-whatsapp]].

### P-04 · Región de datos y marco legal
UE, EEUU o LatAm. GDPR, LFPDPPP, u otro. Decide dónde vive PostgreSQL y si hacen falta DPA con subencargados. Cambiarlo después es una migración de datos personales, no un cambio de configuración.

### P-05 · ¿Hay cliente concreto esperando el MVP, o es producto especulativo?
Si hay cliente, sus canales y su volumen mandan sobre el orden de fases del prompt maestro.

### P-06 · Volumen esperado en el año 1
Inquilinos, mensajes/mes, pico por hora. Dimensiona el particionado, Redis, y decide si hace falta réplica de lectura desde el inicio o si basta con vistas materializadas.

## Importantes — no paran el ARCH, sí la fase que tocan

### P-07 · Retención de conversaciones
El requisito 11 pide retención configurable **por inquilino**, pero el particionado por fecha solo da borrado barato (`DETACH PARTITION`) con una retención **global**. Una retención por inquilino más corta obliga a borrado selectivo por lotes, con su coste de vacuum. ¿Retención global uniforme, o pagamos el borrado selectivo? Es una contradicción real entre dos requisitos del documento.

### P-08 · Criterio de fusión de contactos
Un WhatsApp y un Instagram son la misma persona ¿por qué? Solo teléfono verificado, solo fusión manual del agente, o heurística. ¿Se puede deshacer? Ver [[ADR-006-identidad-contactos]] (pendiente). La fusión automática por nombre queda descartada de entrada.

### P-09 · Visibilidad entre agentes
¿Un agente ve conversaciones no asignadas a él? Cambia las políticas RLS, no solo la interfaz.

### P-10 · Proveedor de pagos
Stripe estaba como "referencia", no como decisión. ¿Opera en el país de facturación? ¿Hace falta factura fiscal local (SAT, DIAN, AFIP)? Un requisito fiscal descubierto en fase 4 es un módulo entero, no un campo.

### P-11 · IA: BYOK obligatorio o consumo del plan *(lista de parada, parcialmente)*
Si es consumo del plan, nosotros pagamos tokens y el techo de gasto deja de ser una baranda para ser una necesidad contable. Y la pregunta que sí es de lista de parada: **¿el contenido de las conversaciones puede salir hacia un proveedor de IA de terceros?** Son datos personales de los clientes de nuestros clientes.

### P-12 · Base de conocimiento de IA
¿RAG con pgvector (extensión de PostgreSQL, no dependencia nueva), servicio externo de embeddings (costo recurrente → lista de parada), o basta con inyectar texto plano en el prompt? Para bases de conocimiento pequeñas la tercera opción es suficiente y ahorra un subsistema entero.

### P-13 · Infraestructura de despliegue
Hay un MCP de Hostinger conectado en la sesión de trabajo. ¿El destino es un VPS de Hostinger, o Fly / Railway / AWS? Decide si PostgreSQL es gestionado o nuestro, y eso decide quién hace los backups y quién responde a las tres de la mañana.

### P-14 · Presupuesto de infraestructura mensual
Sin una cifra no puedo decidir entre réplica de lectura sí o no, Redis gestionado, ni evaluar BullMQ Pro — que resolvería de forma nativa el reparto justo entre inquilinos del [[ADR-003-estrategia-colas]], a cambio de licencia de pago.

## Menores — decido yo si no hay respuesta

- **P-15** Idioma de la interfaz: solo español, o i18n desde el inicio. *(Por defecto: i18n desde el inicio, es barato al principio y caro después.)*
- **P-16** Embudo de ventas: etapas fijas o configurables por inquilino. *(Por defecto: configurables.)*
- **P-17** ¿SSO/SAML en el roadmap? Cambia la relación entre `users` y `memberships`. *(Por defecto: no en el MVP, pero el esquema lo permite.)*
- **P-18** ¿Marca blanca con dominio propio del cliente? Afecta a webhooks entrantes y a los correos. *(Por defecto: no en el MVP.)*
- **P-19** Exportación del panel: ¿CSV basta, o hace falta Excel/PDF? *(Por defecto: CSV.)*
- **P-20** ¿Quién opera producción y hay guardia? Define el umbral de la alerta de "webhook sin llegar durante N minutos" del requisito 8.10. *(Por defecto: N = 15 minutos.)*

## Resueltas

| # | Pregunta | Respuesta | Fecha |
|---|---|---|---|
| R-01 | Alcance del PR-0 | Vault + `git init`, sin andamiaje de monorepo | 2026-09-07 |
| R-02 | Skills a instalar | `claude-security`, `frontend-design`, `feature-dev` | 2026-09-07 |
