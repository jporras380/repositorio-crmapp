-- 0001 · Cimientos: esquema app, rol de aplicación y las dos funciones que
-- hacen que RLS y particionado sean difíciles de olvidar.
--
-- Ver ADR-005 (RLS) y ADR-006 (particionado e idempotencia).

-- citext: los correos y los slugs se comparan sin distinguir mayúsculas.
-- Hacerlo con lower() en cada consulta funciona hasta que alguien olvida una,
-- y entonces hay dos cuentas con el mismo correo.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- Identidad del inquilino en la transacción actual.
--
-- `nullif(..., '')` no es cosmético: si alguien hace SET LOCAL app.tenant_id = ''
-- el cast directo a uuid lanza excepción y el error que ve el usuario no dice
-- nada útil. Así devuelve NULL, y NULL contra tenant_id no es TRUE, con lo que
-- la política simplemente no deja ver nada. Fallar cerrado, no fallar ruidoso.
--
-- El segundo argumento `true` de current_setting evita que lance si el GUC
-- nunca se estableció.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.current_tenant_id() IS
  'Inquilino de la transacción actual. NULL si no se estableció: las políticas RLS no dejan ver nada.';

-- ---------------------------------------------------------------------------
-- Rol de aplicación.
--
-- NO es owner de las tablas. Con FORCE ROW LEVEL SECURITY el owner también
-- queda sujeto a las políticas, pero mantener la separación de roles es
-- defensa en profundidad barata: las migraciones corren con otro rol.
--
-- Sin LOGIN ni contraseña aquí. Las credenciales se conceden fuera de la
-- migración (en desarrollo, `pnpm db:dev-role`), porque los roles son del
-- clúster y no de la base de datos: meterlos en una migración con contraseña
-- pondría un secreto en el repositorio.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmapp_app') THEN
    CREATE ROLE crmapp_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO crmapp_app;
GRANT USAGE ON SCHEMA app TO crmapp_app;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO crmapp_app;

-- ---------------------------------------------------------------------------
-- Activa aislamiento por inquilino sobre una tabla.
--
-- Existe para que la política sea una línea y no diez: cuanto más corto sea
-- hacerlo bien, menos probable es que alguien lo omita al añadir una tabla.
-- El test de catálogo (test/rls.test.ts) es la red que atrapa el olvido.
--
-- WITH CHECK además de USING: sin él, un inquilino podría INSERTAR filas con
-- el tenant_id de otro. USING filtra lo que se lee, WITH CHECK valida lo que
-- se escribe. Omitir el segundo es el error clásico de RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);

  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING (tenant_id = app.current_tenant_id())
       WITH CHECK (tenant_id = app.current_tenant_id())', tbl);

  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO crmapp_app', tbl);
END
$$;

-- ---------------------------------------------------------------------------
-- Crea una partición mensual si no existe.
--
-- Aplica RLS a la partición además de al padre. No es redundante: en
-- PostgreSQL, consultar una partición DIRECTAMENTE aplica solo las políticas
-- de esa partición, no las del padre. Sin esto, `SELECT * FROM messages_2026_09`
-- se saltaría el aislamiento entre inquilinos. Es la diferencia entre una
-- garantía real y una nominal.
--
-- No se crea partición DEFAULT a propósito: una DEFAULT que acumule filas
-- impide crear después la partición del rango correspondiente, y convierte un
-- despiste del job en una migración manual. Preferimos que la inserción falle
-- ruidosamente y que el job de precreación tenga alerta propia.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ensure_partition(
  parent regclass,
  desde date,
  con_tenant_rls boolean DEFAULT true,
  -- `audit_log` es de solo inserción: sus particiones no pueden conceder
  -- UPDATE ni DELETE, o la auditoría deja de serlo.
  permisos text DEFAULT 'SELECT, INSERT, UPDATE, DELETE'
) RETURNS text
  LANGUAGE plpgsql
AS $$
DECLARE
  hasta        date := (desde + interval '1 month')::date;
  nombre       text := format('%s_%s', parent::text, to_char(desde, 'YYYY_MM'));
  ya_existe    boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = nombre
  ) INTO ya_existe;

  IF ya_existe THEN
    RETURN nombre;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
    nombre, parent, desde, hasta);

  IF con_tenant_rls THEN
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', nombre);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', nombre);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app.current_tenant_id())
         WITH CHECK (tenant_id = app.current_tenant_id())', nombre);
  END IF;

  EXECUTE format('GRANT %s ON %I TO crmapp_app', permisos, nombre);

  RETURN nombre;
END
$$;

-- ---------------------------------------------------------------------------
-- Precrea particiones para los próximos N meses. La llama un job programado.
--
-- Que falte una partición no es un error recuperable: es una caída de la
-- ingesta. El job que llama a esto necesita alerta propia (ARCH §13).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ensure_partitions_ahead(meses int DEFAULT 3)
  RETURNS SETOF text
  LANGUAGE plpgsql
AS $$
DECLARE
  base date := date_trunc('month', now())::date;
  i    int;
BEGIN
  -- Desde el mes anterior, para que un reproceso de eventos atrasados no
  -- se estrelle contra una partición inexistente.
  FOR i IN -1 .. meses LOOP
    RETURN NEXT app.ensure_partition(
      'public.messages', (base + (i || ' month')::interval)::date);
    RETURN NEXT app.ensure_partition(
      'public.audit_log', (base + (i || ' month')::interval)::date,
      true, 'SELECT, INSERT');
    RETURN NEXT app.ensure_partition(
      'public.inbound_events', (base + (i || ' month')::interval)::date);
  END LOOP;
END
$$;

COMMENT ON FUNCTION app.ensure_partitions_ahead(int) IS
  'Precrea particiones mensuales. Llamada por job; su fallo es caída de ingesta, no aviso.';
