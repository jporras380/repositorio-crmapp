-- 0045 · Vistas de bandeja compartidas con el equipo.
--
-- La migración 0020 dejó escrito cómo hacer esto: «compartirlas es otra
-- función, y cuando haga falta se añade una columna, no se rehace esto».
-- Esto es esa columna.
--
-- ## Para qué sirve
--
-- Un supervisor define «Sin responder hoy» con sus cinco filtros y la comparte
-- una vez. El resto del equipo la tiene sin tener que reconstruirla cada uno,
-- que es como acaban existiendo cinco versiones distintas de lo mismo y nadie
-- mira la misma bandeja.
--
-- ## Quién la ve y quién la toca
--
-- Compartida la ve todo el equipo; la edita y la borra **solo quien la creó**.
--
-- Eso lo garantiza el SERVICIO con un `WHERE user_id = $1` en el UPDATE y en
-- el DELETE, no una política de base de datos. Se dice aquí en vez de dejarlo
-- creer: la RLS de este proyecto lleva el inquilino en el contexto de sesión
-- (`app.tenant_id`) y **no el usuario**, así que no hay con qué escribir una
-- política por autor sin añadir `app.user_id` a todas las transacciones.
--
-- Lo que cuesta: es la única garantía de este archivo que vive en el código y
-- no en la base. El daño si se rompiera es que alguien borre una vista ajena
-- de su propia cuenta —molesto, no grave, y sin salir del inquilino—, que es
-- por lo que no justifica tocar el mecanismo de sesión entero.
ALTER TABLE inbox_views
  ADD COLUMN is_public boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN inbox_views.is_public IS
  'Compartida con todo el equipo. La ve cualquiera; la cambia solo su autor.';

-- El único índice que hacía falta: la bandeja pide «las mías y las
-- compartidas» en cada carga, y sin esto recorre todas las del inquilino.
CREATE INDEX inbox_views_compartidas_idx ON inbox_views (tenant_id)
  WHERE is_public;

-- El nombre era único POR USUARIO. Con vistas compartidas eso deja de bastar:
-- dos personas pueden compartir dos «Urgentes» distintas y el equipo vería dos
-- filas con el mismo nombre sin forma de distinguirlas.
--
-- Entre las compartidas el nombre es único en toda la cuenta. Las privadas
-- siguen siendo cosa de cada uno: que dos agentes tengan su propia «Urgentes»
-- no molesta a nadie porque no se cruzan.
CREATE UNIQUE INDEX inbox_views_compartida_nombre_uq
  ON inbox_views (tenant_id, lower(name))
  WHERE is_public;
