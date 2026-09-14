-- 0021 · El hotel: tipos de habitación, habitaciones, tarifas y servicios.
--
-- ## Lo que se guarda y lo que no
--
-- Aquí vive el CATÁLOGO: qué se vende y a cuánto. Las reservas —quién,
-- cuándo, cuánto se cobró— son la migración siguiente, y a propósito: el
-- catálogo cambia (sube la tarifa de verano) y una reserva ya hecha no puede
-- cambiar con él. Por eso la reserva copiará el precio en el momento de
-- cotizar, en vez de apuntar a la tarifa.
--
-- ## Ningún precio en el código
--
-- La migración NO siembra tipos ni tarifas. El encargo nombra los cuatro
-- tipos actuales del Apart Hotel, pero sembrarlos aquí los metería en cada
-- cuenta que se dé de alta, y sus precios quedarían escritos en un archivo
-- que no puede editar nadie del hotel. Se crean desde la pantalla de
-- administración, que es donde se cambiarán después.
--
-- ## Sin disponibilidad, todavía
--
-- Decisión explícita del usuario para esta entrega: el sistema no calcula
-- ocupación ni impide la sobreventa. Las habitaciones tienen estado
-- (disponible / mantenimiento / fuera de servicio), que es lo que se consulta
-- a diario, pero no un calendario.

-- ---------------------------------------------------------------------------
-- Tipos de habitación
-- ---------------------------------------------------------------------------
CREATE TABLE room_types (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  -- Cuántas personas caben. Es lo primero que pregunta quien escribe
  -- («¿tienen para 5?») y lo que filtra el cotizador.
  capacity         int NOT NULL DEFAULT 2 CHECK (capacity BETWEEN 1 AND 50),
  -- Precio por noche cuando ninguna tarifa aplica. NULL significa «sin precio
  -- de lista»: el cotizador lo dice en vez de inventarse un cero.
  base_rate_cents  bigint CHECK (base_rate_cents IS NULL OR base_rate_cents >= 0),
  currency         char(3) NOT NULL DEFAULT 'PEN',
  -- Archivar y no borrar: un tipo con reservas pasadas no puede desaparecer,
  -- pero sí dejar de ofrecerse.
  active           boolean NOT NULL DEFAULT true,
  position         int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX room_types_nombre_uq ON room_types (tenant_id, lower(name));
SELECT app.enable_tenant_rls('room_types');

-- ---------------------------------------------------------------------------
-- Habitaciones
-- ---------------------------------------------------------------------------
CREATE TABLE rooms (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- RESTRICT: no se borra un tipo que todavía tiene habitaciones colgando.
  room_type_id uuid NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  -- «Bungalow 3», «204». Lo que dice recepción, no un número interno.
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'disponible'
                 CHECK (status IN ('disponible', 'mantenimiento', 'fuera_de_servicio')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rooms_nombre_uq ON rooms (tenant_id, lower(name));
CREATE INDEX rooms_tipo_idx ON rooms (room_type_id);
SELECT app.enable_tenant_rls('rooms');

-- ---------------------------------------------------------------------------
-- Tarifas
-- ---------------------------------------------------------------------------
-- Una tarifa es «este tipo, entre estas fechas, cuesta tanto por noche». Si
-- dos se pisan —«Temporada alta» y dentro «Fiestas Patrias»— gana la de rango
-- MÁS CORTO: la más específica es la que alguien creó a propósito para esas
-- noches. La regla vive en `packages/core/src/tarifas.ts`, con tests; aquí
-- solo se guardan los datos.
CREATE TABLE rates (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_type_id uuid NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- Fechas de calendario, sin hora ni zona: una noche del 28 de julio es la
  -- del 28 en Barranca, no las 00:00 UTC de ningún sitio.
  valid_from   date NOT NULL,
  valid_to     date NOT NULL,
  price_cents  bigint NOT NULL CHECK (price_cents >= 0),
  -- Noches mínimas para que aplique esta tarifa. En fechas punta un hotel no
  -- vende una sola noche, y el cotizador tiene que avisarlo.
  min_nights   int NOT NULL DEFAULT 1 CHECK (min_nights >= 1),
  -- Días de la semana en que aplica (0 = domingo … 6 = sábado). NULL = todos.
  -- Es lo que permite «viernes y sábado cuestan más» sin una tarifa por fecha.
  weekdays     int[] CHECK (weekdays IS NULL OR weekdays <@ ARRAY[0,1,2,3,4,5,6]),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to >= valid_from)
);
CREATE INDEX rates_tipo_idx ON rates (room_type_id, valid_from);
SELECT app.enable_tenant_rls('rates');

-- ---------------------------------------------------------------------------
-- Servicios adicionales
-- ---------------------------------------------------------------------------
-- Desayuno, cochera, cama extra. Se cobran de tres formas distintas y el
-- total cambia mucho según cuál: un desayuno por persona y noche para una
-- familia de cinco en tres noches son quince desayunos, no uno.
CREATE TABLE hotel_services (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents >= 0),
  currency    char(3) NOT NULL DEFAULT 'PEN',
  unit        text NOT NULL DEFAULT 'por_estancia'
                CHECK (unit IN ('por_estancia', 'por_noche', 'por_persona_noche')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hotel_services_nombre_uq ON hotel_services (tenant_id, lower(name));
SELECT app.enable_tenant_rls('hotel_services');
