-- 0002 · Inquilinos, usuarios, equipos y auditoría.

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text        NOT NULL,
  slug        citext      NOT NULL UNIQUE,
  status      text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- `tenants` es la excepción deliberada al aislamiento por `tenant_id`: la fila
-- ES el inquilino. Su política compara contra la clave primaria.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO crmapp_app;

-- ---------------------------------------------------------------------------
-- Usuarios: identidad GLOBAL, sin tenant_id.
--
-- Un usuario puede pertenecer a varios inquilinos (caso agencia), así que no
-- puede llevar tenant_id. Pero sin política sería una tabla legible por
-- cualquier inquilino, es decir una lista de correos de todos los clientes:
-- por eso la política es de pertenencia, no de igualdad.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  email          citext      NOT NULL UNIQUE,
  password_hash  text,
  full_name      text        NOT NULL,
  avatar_url     text,
  mfa_secret_id  uuid,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  -- El rol vive aquí y no en `users`: el mismo usuario puede ser propietario
  -- en su cuenta y agente en la de un cliente.
  role       text        NOT NULL
               CHECK (role IN ('owner', 'admin', 'supervisor', 'agent')),
  status     text        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
SELECT app.enable_tenant_rls('memberships');
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- Se declara después de `memberships` porque la política la referencia.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_members ON users
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = users.id
      AND m.tenant_id = app.current_tenant_id()
  ));
-- WITH CHECK aparte: al crear un usuario todavía no existe su membresía, así
-- que la condición de lectura no puede aplicarse a la escritura. El control de
-- quién puede crear usuarios es de la capa de aplicación, no de RLS.
CREATE POLICY user_insert ON users FOR INSERT WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO crmapp_app;

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT app.enable_tenant_rls('teams');

CREATE TABLE team_members (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES teams(id)   ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, membership_id)
);
SELECT app.enable_tenant_rls('team_members');

CREATE TABLE business_hours (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id    uuid        REFERENCES teams(id) ON DELETE CASCADE,
  -- La zona horaria es del equipo, no del servidor: un equipo en Bogotá y otro
  -- en Madrid tienen horarios distintos sobre el mismo instante.
  timezone   text        NOT NULL,
  schedule   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('business_hours');

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email        citext      NOT NULL,
  role         text        NOT NULL
                 CHECK (role IN ('owner', 'admin', 'supervisor', 'agent')),
  -- Se guarda el hash, no el token: quien lea la base no debe poder aceptar
  -- invitaciones ajenas.
  token_hash   text        NOT NULL UNIQUE,
  invited_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('invitations');
CREATE UNIQUE INDEX invitations_pendientes_idx
  ON invitations (tenant_id, email) WHERE accepted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Auditoría. Particionada por mes y de solo inserción.
--
-- Al rol de aplicación NO se le conceden UPDATE ni DELETE: un registro de
-- auditoría que la aplicación puede reescribir no es auditoría. Por eso no
-- usa app.enable_tenant_rls(), que concede los cuatro permisos.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          uuid        NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid        NOT NULL,
  actor_user_id uuid,
  action      text        NOT NULL,
  entity_type text        NOT NULL,
  entity_id   uuid,
  meta        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT ON audit_log TO crmapp_app;

CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, created_at DESC);
