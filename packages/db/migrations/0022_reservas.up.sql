-- 0022 · Reservas: quién, cuándo, qué habitación, a cuánto y qué ha pagado.
--
-- ## La reserva COPIA el precio; no apunta a la tarifa
--
-- El catálogo (0021) cambia: el hotel sube la tarifa de verano en marzo. Una
-- reserva hecha en enero no puede subir con ella. Por eso aquí se guardan las
-- líneas tal como se cotizaron —cada noche con su precio y el nombre de la
-- tarifa que lo puso, cada servicio con su cantidad— y el total. La tarifa se
-- puede borrar mañana y la reserva sigue diciendo lo mismo.
--
-- Las fechas de una reserva NO se editan. Cambiar de fechas es recotizar, y
-- recotizar con el catálogo de hoy puede cambiar el precio que se le dio al
-- cliente; hacerlo en silencio desde un formulario es como se cobra de más.
-- Se cancela y se crea otra, y las dos quedan en el historial.
--
-- ## Estado de la reserva y etapa del embudo son cosas distintas
--
-- Consulta, Interesado y Cotización son del embudo (ADR-013): todavía no hay
-- reserva. La reserva nace «pendiente» y sigue su propio ciclo —confirmada,
-- en casa, finalizada, cancelada—, con las transiciones validadas en
-- `packages/core/src/reservas.ts`. Confirmarla gana el lead; eso lo hace el
-- servicio en la misma transacción.
--
-- ## Sin disponibilidad
--
-- Decisión explícita: no hay motor de ocupación. Lo único que se comprueba es
-- lo barato y grave —dos reservas vivas en la MISMA habitación concreta que se
-- solapan— y se AVISA, no se bloquea.

CREATE TABLE reservations (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- RESTRICT y no CASCADE: anonimizar un cliente (0019) no borra filas, y
  -- borrar de verdad a alguien con reservas no debe poder llevárselas.
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  room_type_id    uuid NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  -- La habitación concreta se puede asignar después: al reservar se vende un
  -- tipo; qué bungalow exacto se decide cerca de la fecha.
  room_id         uuid REFERENCES rooms(id) ON DELETE SET NULL,
  -- Copiado del tipo al reservar, por la misma razón que el precio.
  room_type_name  text NOT NULL,
  check_in        date NOT NULL,
  check_out       date NOT NULL,
  guests          int NOT NULL CHECK (guests BETWEEN 1 AND 50),
  status          text NOT NULL DEFAULT 'pendiente'
                    CHECK (status IN ('pendiente', 'confirmada', 'en_casa', 'finalizada', 'cancelada')),
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  currency        char(3) NOT NULL DEFAULT 'PEN',
  notes           text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz,
  CHECK (check_out > check_in)
);
CREATE INDEX reservations_llegadas_idx ON reservations (tenant_id, check_in);
CREATE INDEX reservations_contacto_idx ON reservations (contact_id, check_in DESC);
CREATE INDEX reservations_conversacion_idx ON reservations (conversation_id);
-- El aviso de solape mira solo reservas vivas de una habitación concreta.
CREATE INDEX reservations_habitacion_idx ON reservations (room_id, check_in)
  WHERE room_id IS NOT NULL AND status IN ('pendiente', 'confirmada', 'en_casa');
SELECT app.enable_tenant_rls('reservations');

-- Las líneas, tal como se cotizaron. `kind` distingue lo que se lee distinto
-- en la ficha: una noche lleva fecha y tarifa; un servicio, cantidad; un
-- descuento, importe negativo y quién lo dio.
CREATE TABLE reservation_lines (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('noche', 'servicio', 'descuento')),
  description    text NOT NULL,
  night          date,
  quantity       int NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  unit_cents     bigint NOT NULL,
  total_cents    bigint NOT NULL,
  position       int NOT NULL DEFAULT 0
);
CREATE INDEX reservation_lines_reserva_idx ON reservation_lines (reservation_id, position);
SELECT app.enable_tenant_rls('reservation_lines');

-- Pagos del HUÉSPED al hotel. Nada que ver con `subscription_payments` (0016),
-- que es el hotel pagándonos a nosotros.
CREATE TABLE reservation_payments (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  -- Los que se usan en Perú. Yape y Plin no son «transferencia»: se concilian
  -- distinto y el hotel los cuenta aparte.
  method         text NOT NULL
                   CHECK (method IN ('efectivo', 'transferencia', 'yape', 'plin', 'tarjeta', 'otro')),
  reference      text,
  paid_at        timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_payments_reserva_idx ON reservation_payments (reservation_id, paid_at);
SELECT app.enable_tenant_rls('reservation_payments');

-- El historial: quién la movió y cuándo. Sin él, «¿quién canceló esta
-- reserva?» no tiene respuesta.
CREATE TABLE reservation_events (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  type           text NOT NULL,
  from_status    text,
  to_status      text,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  meta           jsonb,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_events_reserva_idx ON reservation_events (reservation_id, at);
SELECT app.enable_tenant_rls('reservation_events');
