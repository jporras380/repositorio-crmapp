-- 0007 · Planes y suscripciones.
--
-- Modela el ciclo prueba → gracia → suspensión que implementa
-- packages/core/src/entitlements.ts. La lógica vive allí, en dominio puro; aquí
-- solo están los datos de los que esa lógica deriva.

-- ---------------------------------------------------------------------------
-- Catálogo de planes. GLOBAL, sin tenant_id.
--
-- Es la excepción legítima al aislamiento por inquilino, y aun así lleva RLS
-- activada y forzada: no se mete en la lista de excepciones del test de
-- catálogo, se le da una política que dice la verdad — el catálogo es público.
-- Un permiso de solo SELECT completa la garantía: ningún inquilino puede
-- inventarse un plan con límites a su medida.
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  code         citext NOT NULL UNIQUE,
  name         text   NOT NULL,
  price_cents  int    NOT NULL CHECK (price_cents >= 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  period       text   NOT NULL DEFAULT 'month' CHECK (period IN ('month', 'year')),
  -- Agentes, canales, conversaciones al mes, ejecuciones de bot, créditos de IA.
  -- jsonb porque los límites cambian con el catálogo comercial y no queremos
  -- una migración cada vez que marketing inventa un plan.
  limits       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  -- Duración de prueba y gracia POR PLAN. Se copian a la suscripción al
  -- crearla: cambiar el plan no debe alterar el trato de quien ya firmó.
  trial_months int    NOT NULL DEFAULT 1  CHECK (trial_months >= 0),
  grace_days   int    NOT NULL DEFAULT 7  CHECK (grace_days >= 0),
  is_public    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
CREATE POLICY catalogo_publico ON plans FOR SELECT USING (true);
GRANT SELECT ON plans TO crmapp_app;

COMMENT ON POLICY catalogo_publico ON plans IS
  'El catálogo de planes es público. Sin tenant_id porque no pertenece a nadie.';

-- ---------------------------------------------------------------------------
-- Suscripciones. Una por inquilino.
--
-- `status` es una CACHÉ, no la verdad. El estado efectivo lo deriva
-- packages/core de las fechas, porque un job que actualice la columna cada
-- hora deja una ventana en la que un cliente cuya gracia venció a las 3 de la
-- mañana seguiría enviando. Las fechas mandan; la columna sirve para listar y
-- para saber si alguien canceló.
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id    uuid NOT NULL REFERENCES plans(id),

  -- Intención declarada. 'cancelled' significa "no renueves", no "córtame
  -- ahora": el cliente conserva lo que pagó hasta el fin del periodo.
  status     text NOT NULL DEFAULT 'trialing'
               CHECK (status IN ('trialing', 'active', 'cancelled')),

  trial_ends_at          timestamptz,
  current_period_ends_at timestamptz,

  -- Copiado del plan al crear la suscripción, NO leído del plan al evaluar.
  -- Si se leyera del plan, cambiar la gracia de 7 a 14 días alargaría la de
  -- todos los clientes vivos, retroactivamente.
  grace_days int NOT NULL DEFAULT 7 CHECK (grace_days >= 0),

  -- Caché del estado efectivo, para listados y para detectar transiciones.
  -- Nadie decide un envío mirando esto.
  cached_state    text CHECK (cached_state IN ('prueba', 'activa', 'gracia', 'suspendida')),
  cached_state_at timestamptz,

  -- Proveedor de pagos (P-10 sin cerrar: Stripe era referencia, no decisión).
  provider                 text,
  provider_customer_id     text,
  provider_subscription_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('subscriptions');

-- El job de mantenimiento busca suscripciones que acaban de cruzar un límite.
-- Sin estos índices haría un recorrido completo cada vuelta.
CREATE INDEX subscriptions_fin_de_prueba_idx
  ON subscriptions (trial_ends_at) WHERE trial_ends_at IS NOT NULL;
CREATE INDEX subscriptions_fin_de_periodo_idx
  ON subscriptions (current_period_ends_at) WHERE current_period_ends_at IS NOT NULL;
CREATE INDEX subscriptions_estado_idx ON subscriptions (cached_state);

-- ---------------------------------------------------------------------------
-- Planes iniciales.
--
-- Se siembran en la migración porque el producto no arranca sin catálogo: una
-- cuenta nueva necesita un plan al que apuntar. Los precios son marcador de
-- posición hasta que se cierre P-21.
-- ---------------------------------------------------------------------------
INSERT INTO plans (code, name, price_cents, limits, trial_months, grace_days) VALUES
  ('starter', 'Starter', 2500,
   '{"agentes": 3, "canales": 1, "conversaciones_mes": 1000, "bot_runs_mes": 500, "creditos_ia_mes": 750}',
   1, 7),
  ('growth', 'Growth', 4900,
   '{"agentes": 10, "canales": 3, "conversaciones_mes": 5000, "bot_runs_mes": 5000, "creditos_ia_mes": 2500}',
   1, 7),
  ('scale', 'Scale', 9900,
   '{"agentes": 30, "canales": 10, "conversaciones_mes": 25000, "bot_runs_mes": 25000, "creditos_ia_mes": 10000}',
   1, 7);
