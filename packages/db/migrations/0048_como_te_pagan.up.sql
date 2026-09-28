-- 0048 · Cómo se le paga a la plataforma.
--
-- ## El hueco que cierra
--
-- La pantalla de Suscripción decía «los pagos se hacen por transferencia y
-- los registramos nosotros al recibirlos» y **en ningún sitio decía a dónde
-- transferir**. Ni cuenta, ni CCI, ni Yape. El cliente leía eso y tenía que
-- escribir para preguntar.
--
-- ADR-011 decidió cobro manual, sin pasarela. Eso sigue en pie: lo que
-- faltaba no era una pasarela, era **decir los datos**. La mitad manual del
-- cobro manual estaba sin construir.
--
-- ## Dos tablas y por qué son dos
--
-- 1. `platform_payment_settings`: los datos de cobro de la PLATAFORMA. Una
--    sola fila, global, la misma para todos los inquilinos.
-- 2. `payment_claims`: «he pagado, aquí está el voucher», que dice el cliente.
--
-- Lo segundo NO entra en `subscription_payments`. Esa tabla es el libro del
-- dinero cobrado —la lee el estado de la suscripción y decide si la cuenta
-- sigue viva—, y el cliente no escribe en el libro. Declara, y el operador
-- confirma. Mezclarlas dejaría que cualquiera se diera por pagado.

-- ---------------------------------------------------------------------------
-- Los datos de cobro de la plataforma. Una fila.
-- ---------------------------------------------------------------------------
--
-- Una fila forzada con un `id` fijo y un CHECK: sin eso, un INSERT despistado
-- deja dos filas y la pantalla del cliente enseña una u otra según el orden
-- del planificador, que es el peor fallo posible aquí.
CREATE TABLE platform_payment_settings (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Transferencia. Todo texto y todo opcional: hasta que el operador los
  -- rellene, la pantalla del cliente no promete un método que no existe.
  banco             text,
  tipo_de_cuenta    text,
  numero_de_cuenta  text,
  cci               text,
  titular           text,
  documento_titular text,

  -- Yape y Plin. El QR se guarda como clave del almacén, no como `media_asset`:
  -- esa tabla lleva `tenant_id` y esto no es de ningún inquilino. Lo firma un
  -- endpoint que cualquier usuario autenticado puede llamar, porque es
  -- justamente el dato que hay que enseñar para cobrar.
  numero_billetera  text,
  titular_billetera text,
  qr_storage_key    text,
  qr_mime           text,

  -- Los planes están en USD y Yape cobra en soles. El importe en soles lo fija
  -- el operador a mano, por plan: una API de tipo de cambio es un servicio
  -- externo de coste recurrente y un número que se mueve solo el día que a
  -- alguien le cobran de más.
  --
  -- `{"starter": 9500, "growth": 19000}`, en céntimos de sol.
  soles_por_plan    jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Lo que hay que poner en el detalle de la transferencia, con las palabras
  -- del operador. Sin esto, llegan pagos que nadie sabe de quién son.
  nota              text,

  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users (id) ON DELETE SET NULL
);

-- La fila existe desde el principio, vacía. Así la pantalla del cliente lee
-- siempre algo y el operador edita en vez de crear.
INSERT INTO platform_payment_settings (id) VALUES (1);

ALTER TABLE platform_payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_payment_settings FORCE ROW LEVEL SECURITY;

-- Igual que el catálogo de planes (0007): lo lee cualquiera porque es lo que
-- hay que enseñar para cobrar, y no contiene nada de ningún inquilino.
CREATE POLICY datos_de_cobro_publicos ON platform_payment_settings
  FOR SELECT USING (true);
GRANT SELECT ON platform_payment_settings TO crmapp_app;

COMMENT ON POLICY datos_de_cobro_publicos ON platform_payment_settings IS
  'Son los datos para pagarnos: enseñarlos es el punto. No hay nada de ningún inquilino aquí.';

-- El operador los edita desde su consola. Escribe con el rol de la plataforma
-- (0040), no con el de ningún inquilino.
GRANT SELECT, UPDATE ON platform_payment_settings TO crmapp_operador;
CREATE POLICY operador_edita_cobro ON platform_payment_settings
  FOR UPDATE TO crmapp_operador USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- «He pagado»: lo que declara el cliente, con su comprobante.
-- ---------------------------------------------------------------------------
CREATE TABLE payment_claims (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  declared_by    uuid NOT NULL REFERENCES users (id),

  amount_cents   integer NOT NULL CHECK (amount_cents > 0),
  currency       char(3) NOT NULL DEFAULT 'USD',
  method         text    NOT NULL CHECK (method IN ('transferencia', 'yape', 'plin', 'otro')),
  -- El número de operación que da el banco o la app. Es lo que permite
  -- cuadrarlo contra el extracto sin llamar a nadie.
  reference      text,
  paid_at        date    NOT NULL,

  -- El voucher: PDF o imagen. Es del inquilino que lo sube, así que aquí sí
  -- vale `media_assets` con su RLS de siempre.
  media_asset_id uuid REFERENCES media_assets (id) ON DELETE SET NULL,

  -- `pendiente` hasta que el operador lo mira. Al confirmarlo se crea la fila
  -- en `subscription_payments`, que es el libro de verdad, y se apunta aquí
  -- cuál es para poder ir de una a otra.
  status         text NOT NULL DEFAULT 'pendiente'
                   CHECK (status IN ('pendiente', 'confirmado', 'rechazado')),
  reviewed_at    timestamptz,
  reviewed_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Por qué se rechazó, con palabras. Un rechazo sin motivo obliga a escribir
  -- para preguntar, que es justo lo que esto viene a evitar.
  review_note    text,
  payment_id     uuid REFERENCES subscription_payments (id) ON DELETE SET NULL,

  created_at     timestamptz NOT NULL DEFAULT now()
);

SELECT app.enable_tenant_rls('payment_claims');

-- Lo que el cliente ve de sus propias declaraciones, y declarar una nueva.
-- No puede cambiarlas después: una declaración editable no sirve de registro.
GRANT SELECT, INSERT ON payment_claims TO crmapp_app;

-- El operador las lee todas y las resuelve. La lista de columnas que puede
-- escribir es explícita: no puede tocar el importe ni el comprobante que
-- declaró el cliente, solo decir qué hizo con ellos.
GRANT SELECT, UPDATE (status, reviewed_at, reviewed_by, review_note, payment_id)
  ON payment_claims TO crmapp_operador;
CREATE POLICY operador_lee_declaraciones ON payment_claims
  FOR SELECT TO crmapp_operador USING (true);
CREATE POLICY operador_resuelve_declaraciones ON payment_claims
  FOR UPDATE TO crmapp_operador USING (true) WITH CHECK (true);

-- Lo que pregunta la consola: quién dice haber pagado y nadie ha mirado.
CREATE INDEX payment_claims_pendientes_idx ON payment_claims (created_at)
  WHERE status = 'pendiente';
CREATE INDEX payment_claims_del_inquilino_idx ON payment_claims (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Confirmar una declaración: la única forma de que entre en el libro.
-- ---------------------------------------------------------------------------
--
-- El rol de la aplicación NO puede insertar en `subscription_payments`, y eso
-- es deliberado desde 0007: si pudiera, un inquilino se daría por pagado solo.
-- Al confirmar hace falta escribir ahí, y la pregunta es con qué permiso.
--
-- No con un `GRANT INSERT`: eso le daría al operador —o a cualquier fallo en
-- su camino— la capacidad de escribir cualquier pago, de cualquier importe, a
-- cualquier cuenta. Con `SECURITY DEFINER` no gana el permiso: gana **poder
-- llamar a esto**, y lo que esto escribe está aquí y no en el código:
--
-- - El importe, la moneda y el método salen de lo que declaró el cliente. No
--   se pueden pasar por parámetro, así que nadie confirma 1 sol un pago de mil.
-- - Solo una declaración `pendiente`. Confirmar dos veces no duplica el cobro.
--
-- Es el mismo patrón y el mismo motivo que `app.purgar_outbox` (0047).
CREATE OR REPLACE FUNCTION app.confirmar_pago_declarado(
  p_id       uuid,
  p_operador uuid,
  p_desde    date DEFAULT NULL,
  p_hasta    date DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  d      record;
  pago   uuid;
BEGIN
  SELECT * INTO d FROM payment_claims WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'declaracion_no_encontrada';
  END IF;
  IF d.status <> 'pendiente' THEN
    RAISE EXCEPTION 'ya_resuelta';
  END IF;

  INSERT INTO subscription_payments
    (tenant_id, amount_cents, currency, covers_from, covers_to, method, reference)
  VALUES
    (d.tenant_id, d.amount_cents, d.currency,
     COALESCE(p_desde, d.paid_at),
     COALESCE(p_hasta, (d.paid_at + interval '1 month')::date),
     d.method, d.reference)
  RETURNING id INTO pago;

  UPDATE payment_claims
     SET status = 'confirmado', reviewed_at = now(), reviewed_by = p_operador,
         payment_id = pago
   WHERE id = p_id;

  RETURN pago;
END
$$;

REVOKE ALL ON FUNCTION app.confirmar_pago_declarado(uuid, uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.confirmar_pago_declarado(uuid, uuid, date, date) TO crmapp_operador;
GRANT EXECUTE ON FUNCTION app.confirmar_pago_declarado(uuid, uuid, date, date) TO crmapp_app;

-- ---------------------------------------------------------------------------
-- El libro de pagos no conocía Yape ni Plin.
-- ---------------------------------------------------------------------------
--
-- `subscription_payments.method` admitía transferencia, efectivo, tarjeta y
-- otro. Se escribió en 0007, antes de que hubiera forma de que un cliente
-- dijera cómo pagó, y como los pagos los tecleaba el operador nadie echó en
-- falta las dos con las que de verdad se paga en Perú.
--
-- Al confirmar una declaración hecha por Yape, el INSERT reventaba contra este
-- CHECK. Lo encontró un test, no un cliente.
ALTER TABLE subscription_payments DROP CONSTRAINT subscription_payments_method_check;
ALTER TABLE subscription_payments
  ADD CONSTRAINT subscription_payments_method_check
  CHECK (method IN ('transferencia', 'efectivo', 'tarjeta', 'yape', 'plin', 'otro'));
