---
estado: vivo
fecha: 2026-09-07
modulo: meta
tags: [preguntas, bloqueantes, descubrimiento]
---

# Preguntas abiertas

Ordenadas por urgencia. **Bloqueante** significa que el ARCH no se escribe sin la respuesta. Las marcadas *(lista de parada)* corresponden a la sección 9 del prompt maestro: no decido solo aunque tenga opinión.

## Bloqueantes

Quedan tres. P-01 y P-02 se resolvieron el 2026-09-07 con [[ADR-004-modelo-whatsapp]]; P-03 bajó a menor.

> **Señal del 2026-09-09:** el usuario compartió una captura de su cuenta real de Kommo (Nippon Autoparts, Perú: `+51`, moneda `S/`). Apunta a **P-04 = Perú/LatAm**, **P-05 = sí hay primer cliente: el propio usuario**, y **P-10 = facturación en PEN**. No se cierran hasta confirmación explícita, pero los valores por defecto del ARCH deberían moverse en esa dirección.

### P-04 · Región de datos y marco legal
UE, EEUU o LatAm. GDPR, LFPDPPP, u otro. Decide dónde vive PostgreSQL y si hacen falta DPA con subencargados. Cambiarlo después es una migración de datos personales, no un cambio de configuración.

### P-05 · ¿Hay cliente concreto esperando el MVP, o es producto especulativo?
Si hay cliente, sus canales y su volumen mandan sobre el orden de fases. **Subió de importancia con [[ADR-004-modelo-whatsapp]]:** BYO-credentials filtra clientes, porque exige que sepan montar su propio Meta Business Portfolio. Si el mercado objetivo son micro-pymes, Embedded Signup deja de ser destino y pasa a requisito de venta.

### P-06 · Volumen esperado en el año 1
Inquilinos, mensajes/mes, pico por hora. Dimensiona el particionado, Redis, y decide si hace falta réplica de lectura desde el inicio o si basta con vistas materializadas.

## Importantes — no paran el ARCH, sí la fase que tocan

### P-07 · Retención de conversaciones
El requisito 11 pide retención configurable **por inquilino**, pero el particionado por fecha solo da borrado barato (`DETACH PARTITION`) con una retención **global**. Una retención por inquilino más corta obliga a borrado selectivo por lotes, con su coste de vacuum. ¿Retención global uniforme, o pagamos el borrado selectivo? Es una contradicción real entre dos requisitos del documento.

### P-08 · Criterio de fusión de contactos
Un WhatsApp y un Instagram son la misma persona ¿por qué? Solo teléfono verificado, solo fusión manual del agente, o heurística. ¿Se puede deshacer? Ver [[ADR-007-identidad-contactos]] (pendiente). La fusión automática por nombre queda descartada de entrada.

### P-10 · Proveedor de pagos
Stripe estaba como "referencia", no como decisión. ¿Opera en el país de facturación? ¿Hace falta factura fiscal local (SAT, DIAN, AFIP)? Un requisito fiscal descubierto en fase 4 es un módulo entero, no un campo.

### P-11 · IA: BYOK obligatorio o consumo del plan *(lista de parada, parcialmente)*
Si es consumo del plan, nosotros pagamos tokens y el techo de gasto deja de ser una baranda para ser una necesidad contable. Y la pregunta que sí es de lista de parada: **¿el contenido de las conversaciones puede salir hacia un proveedor de IA de terceros?** Son datos personales de los clientes de nuestros clientes.
**Ganó peso con [[ADR-004-modelo-whatsapp]]:** al desaparecer el costo de mensajería, la IA queda como el **único** consumo que realmente nos cuesta dinero, y por tanto el único que tiene sentido medir y facturar. Ver P-21.

### P-12 · Base de conocimiento de IA
¿RAG con pgvector (extensión de PostgreSQL, no dependencia nueva), servicio externo de embeddings (costo recurrente → lista de parada), o basta con inyectar texto plano en el prompt? Para bases de conocimiento pequeñas la tercera opción es suficiente y ahorra un subsistema entero.

### P-13 · Infraestructura de despliegue
Hay un MCP de Hostinger conectado en la sesión de trabajo. ¿El destino es un VPS de Hostinger, o Fly / Railway / AWS? Decide si PostgreSQL es gestionado o nuestro, y eso decide quién hace los backups y quién responde de madrugada.

### P-14 · Presupuesto de infraestructura mensual
Sin una cifra no puedo decidir entre réplica de lectura sí o no, Redis gestionado, ni evaluar BullMQ Pro — que resolvería de forma nativa el reparto justo entre inquilinos del [[ADR-003-estrategia-colas]], a cambio de licencia de pago.

### P-21 · Qué medimos y cobramos nosotros *(nueva, sustituye a P-02)*
Con el costo de mensajería fuera, ¿qué es consumo facturable? Referencia de Kommo, documentada en [[whatsapp]]: suscripción **por asiento** y la **IA como único consumo medido**, con packs de recarga; contactos, leads y campos son límites de plan, no consumo facturado. Es coherente — la IA es lo único donde también le pagamos a un proveedor — y simplifica mucho `usage_events`.
*(Por defecto, si no hay respuesta: copiamos esa estructura.)*

### P-22 · ¿Librería de logging (pino) o el logger propio? *(lista de parada)*
PR-3 trae un logger escrito a mano —JSON por línea, niveles, contexto heredado y redacción— porque añadir una librería de logging es una dependencia de peso y eso se pregunta antes.

Lo que gana pino: transportes, rendimiento medido, muestreo, y no mantener código de infraestructura que no es nuestro negocio. Lo que cuesta: una dependencia más en el camino caliente de todo el sistema.

**El cambio es barato porque la redacción vive en `@crmapp/crypto`, no en el logger.** Lo específico del proyecto no depende de quién escriba la línea.

## Menores — decido yo si no hay respuesta

### P-25 · Campos configurables por cuenta en la conversación
La ficha de Kommo muestra campos definidos por el cliente (presupuesto, dirección de entrega, razón de pérdida…). `contacts.attributes` cubre los del contacto; falta decidir si la conversación/lead necesita los suyos y si se definen con un esquema por inquilino. *(Por defecto: `jsonb` en la conversación con esquema declarado por inquilino, validado en la API.)*


### P-23 · CSS Modules o CSS plano
Convención fijada por el usuario el 2026-09-09: todo el estilo en CSS aparte, nada en línea ni CSS-in-JS. Queda elegir entre CSS Modules (aislamiento automático de nombres) o CSS plano con convención tipo BEM. Ambas cumplen la regla. Se decide al escribir el primer componente. Ver [[web]].

### P-03 · Qué cuenta como "conversación mensual" *(bajada de bloqueante a menor el 2026-09-07)*
A efectos del límite de plan: ¿la ventana de 24 h, o nuestro ciclo abrir/cerrar?
La versión original de esta pregunta asumía que el cliente compararía nuestro conteo con su factura de Meta. Ya no aplica: desde el 1 de julio de 2025 **Meta factura por mensaje entregado, no por conversación** (ver [[whatsapp]]), y con [[ADR-004-modelo-whatsapp]] esa factura ni siquiera pasa por nosotros. Queda como pregunta de producto — qué límite es justo y comprensible —, no de conciliación contable.

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
| **P-01** | Modelo de conexión a WhatsApp | **BYO-credentials.** Tech Provider con Embedded Signup queda como destino documentado, no como compromiso. Ver [[ADR-004-modelo-whatsapp]] | 2026-09-07 |
| **P-24** | Vocabulario de tipos de mensaje | **Inglés en el contrato** (`text`, `image`…). Los valores de un tipo son identificadores de código. Los mapas de traducción desaparecen | 2026-09-09 |
| **P-09** | Visibilidad entre agentes | **Configurable por cuenta, `all` por defecto** (como Kommo); `team` y `assigned` disponibles. Solo restringe al rol `agent`. Ver [[ADR-008-visibilidad-entre-agentes]] | 2026-09-09 |
| **P-02** | Repercutir o absorber el costo de mensajería | **Disuelta.** El cliente paga a Meta directamente: no hay nada que repercutir. Sale de la lista de parada; se elimina el módulo de wallet del roadmap. Lo que queda es P-21 | 2026-09-07 |
