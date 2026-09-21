-- Al quitar las columnas se va con ellas el permiso de UPDATE sobre ellas.
-- Reversa de 0039. Se pierden los datos de facturación y la referencia al
-- comprobante subido; los archivos en sí siguen en `media_assets`, así que
-- nadie se queda sin su documento: se queda sin el enlace desde el pago.
ALTER TABLE users DROP COLUMN IF EXISTS is_operator;

ALTER TABLE subscription_payments
  DROP COLUMN IF EXISTS receipt_number,
  DROP COLUMN IF EXISTS receipt_uploaded_at,
  DROP COLUMN IF EXISTS receipt_media_id;

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_factura_con_ruc_ck,
  DROP CONSTRAINT IF EXISTS subscriptions_billing_doc_type_ck;

ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS billing_address,
  DROP COLUMN IF EXISTS billing_name,
  DROP COLUMN IF EXISTS billing_tax_id,
  DROP COLUMN IF EXISTS billing_doc_type;
