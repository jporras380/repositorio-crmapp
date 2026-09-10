-- 0016 · Pagos de la suscripción (ADR-011).
--
-- El cobro es manual —transferencia y factura— así que un pago es lo que es:
-- una fila que dice cuánto entró, cuándo y qué periodo cubre. No hay pasarela,
-- no hay webhooks, no hay estado externo que conciliar.
--
-- Lo que sí hay es un riesgo evidente del cobro manual: que un inquilino se
-- marque a sí mismo como pagado. Se cierra por PERMISOS y no por buena fe.
-- La aplicación puede leer sus pagos —el cliente tiene derecho a ver su
-- historial— y no puede escribirlos. Quien los escribe es el script del
-- operador, con el rol de migración.

CREATE TABLE subscription_payments (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amount_cents int  NOT NULL CHECK (amount_cents > 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  -- Periodo que cubre este pago. Es lo que mueve `current_period_ends_at`, y
  -- guardarlo aquí permite reconstruir el historial si esa columna se toca mal.
  covers_from  timestamptz NOT NULL,
  covers_to    timestamptz NOT NULL CHECK (covers_to > covers_from),
  method       text NOT NULL DEFAULT 'transferencia'
               CHECK (method IN ('transferencia', 'efectivo', 'tarjeta', 'otro')),
  -- Número de operación, de factura, o lo que permita encontrarlo en el banco.
  reference    text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_payments_tenant_idx
  ON subscription_payments (tenant_id, covers_to DESC);

SELECT app.enable_tenant_rls('subscription_payments');

-- El aislamiento por inquilino lo da la política; esto quita la escritura a la
-- aplicación. Las dos cosas juntas: un inquilino ve sus pagos y no puede
-- inventarse uno.
REVOKE INSERT, UPDATE, DELETE ON subscription_payments FROM crmapp_app;

COMMENT ON TABLE subscription_payments IS
  'Pagos registrados a mano por el operador (ADR-011). La aplicación solo lee.';
