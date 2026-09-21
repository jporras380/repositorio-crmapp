-- 0039 · Factura o boleta, y el comprobante descargable.
--
-- El hotel elige qué comprobante quiere por su suscripción al CRM, y lo sube
-- el administrador de la plataforma dentro de 48 horas desde que se registra
-- el pago.
--
-- ## Por qué factura Y boleta, y no «un comprobante»
--
-- En Perú no son lo mismo y no se eligen por gusto:
--
-- - **Factura**: para quien tiene RUC y va a usar el gasto como crédito
--   fiscal. Exige RUC, razón social y dirección.
-- - **Boleta**: para persona natural. Basta el DNI, y no da crédito fiscal.
--
-- Un hotel formal querrá factura; un alquiler a nombre de una persona, boleta.
-- Guardar solo «un comprobante» obligaría a preguntarlo por WhatsApp cada mes.
--
-- ## Por qué los datos viven en `subscriptions` y no en `tenants`
--
-- Son datos de FACTURACIÓN de la suscripción al CRM, no del negocio. El día
-- que el hotel emita sus propias boletas a sus huéspedes, esos datos serán
-- otros y vivirán en otro sitio; mezclarlos aquí habría garantizado que
-- alguien los confundiera.
ALTER TABLE subscriptions
  ADD COLUMN billing_doc_type text NOT NULL DEFAULT 'boleta',
  ADD COLUMN billing_tax_id   text,
  ADD COLUMN billing_name     text,
  ADD COLUMN billing_address  text;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_billing_doc_type_ck
  CHECK (billing_doc_type IN ('boleta', 'factura'));

-- Una factura sin RUC no es una factura: SUNAT la rechaza y el hotel se queda
-- sin crédito fiscal. Se impide aquí y no solo en la aplicación porque es la
-- clase de dato que alguien acaba insertando por consola.
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_factura_con_ruc_ck
  CHECK (
    billing_doc_type <> 'factura'
    OR (billing_tax_id IS NOT NULL AND billing_name IS NOT NULL AND billing_address IS NOT NULL)
  );

-- El comprobante de un pago concreto, como medio propio y privado.
--
-- No se guarda «cuándo vence el plazo»: son 48 horas desde el pago y se
-- calcula al leer. Un plazo guardado y un pago con fecha cambiada se separan,
-- y entonces la pantalla promete algo que no es.
ALTER TABLE subscription_payments
  ADD COLUMN receipt_media_id   uuid REFERENCES media_assets (id) ON DELETE SET NULL,
  ADD COLUMN receipt_uploaded_at timestamptz,
  ADD COLUMN receipt_number     text;

-- Quién es personal de la PLATAFORMA (nosotros), no del hotel.
--
-- Va en `users` porque `users` es global: la misma persona puede estar en
-- varias cuentas, y ser operador no es un rol dentro de ninguna de ellas —es
-- estar fuera de todas. Un rol de inquilino no podría expresarlo.
--
-- Por defecto FALSO, y no hay forma de activarlo desde la aplicación: se hace
-- por consola, a propósito. Un botón de «hazme operador» es un botón de
-- «dame todas las cuentas».
--
-- Para activarlo por consola hace falta el SUPERUSUARIO: `users` lleva RLS
-- forzada y ni el dueño de la tabla la salta, así que un `UPDATE` desde la
-- cuenta de la aplicación no toca ninguna fila **y no se queja**.
--
-- Con el superusuario del clúster, que en el entorno local es `crmapp`:
--
--   docker compose -f infra/docker-compose.dev.yml exec postgres --     psql -U crmapp -d crmapp --     -c "UPDATE users SET is_operator = true WHERE email = 'tu@correo';"
--
-- Si responde `UPDATE 0`, la RLS se comió la orden: no estás conectado como
-- superusuario.
ALTER TABLE users ADD COLUMN is_operator boolean NOT NULL DEFAULT false;

-- ## El permiso más estrecho que deja subir el comprobante
--
-- En 0016 se le quitó a la aplicación toda escritura sobre `subscription_payments`:
-- un inquilino ve sus pagos y no puede inventarse uno. Esa regla se queda como
-- está — es la que impide que alguien se declare pagado.
--
-- Lo que hace falta es que el operador de la plataforma pueda adjuntar el
-- comprobante, y eso son TRES columnas. PostgreSQL permite conceder UPDATE
-- columna a columna, así que se concede exactamente eso: el importe, las
-- fechas y el método siguen siendo intocables desde la aplicación.
--
-- El permiso lo tiene el rol, no la persona: quién puede usarlo lo decide
-- `users.is_operator`, y la RLS sigue exigiendo que el pago sea del inquilino
-- en cuyo contexto se entra.
GRANT UPDATE (receipt_media_id, receipt_uploaded_at, receipt_number)
  ON subscription_payments TO crmapp_app;
