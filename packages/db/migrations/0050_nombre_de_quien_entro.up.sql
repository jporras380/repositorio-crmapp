-- 0050 · El cliente puede leer el NOMBRE de quien de la plataforma entró en su
-- cuenta.
--
-- ## El fallo
--
-- La política `tenant_members` (0002) solo deja leer en `users` a los
-- miembros de la cuenta propia. El operador nunca lo es, así que al cliente le
-- llegaban «pedido por: (nadie)» en las solicitudes de soporte y respuestas
-- sin firma en el chat. Los tests no lo veían porque en ellos el operador era
-- miembro de la misma cuenta sobre la que actuaba.
--
-- ## Por qué una función y no una política nueva sobre `users`
--
-- Una política que dejara leer al operador entero enseñaría también su
-- correo y su hash de contraseña a cualquier cuenta. Esta función devuelve UN
-- dato —el nombre— y solo de quien dejó rastro en la cuenta que pregunta:
-- pidió acceso de soporte o escribió desde la plataforma en su chat. Es
-- información que el cliente ya debía tener.
--
-- No se mira `is_operator`: si a alguien le quitan el rol mañana, el registro
-- de quién entró el mes pasado tiene que seguir diciéndolo.
CREATE OR REPLACE FUNCTION app.nombre_de_quien_entro(p_user uuid)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT u.full_name
    FROM users u
   WHERE u.id = p_user
     AND (
       EXISTS (SELECT 1 FROM support_grants g
                WHERE g.requested_by = p_user
                  AND g.tenant_id = current_setting('app.tenant_id', true)::uuid)
       OR EXISTS (SELECT 1 FROM support_messages m
                   WHERE m.author_id = p_user AND m.from_platform
                     AND m.tenant_id = current_setting('app.tenant_id', true)::uuid)
     )
$$;

REVOKE ALL ON FUNCTION app.nombre_de_quien_entro(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.nombre_de_quien_entro(uuid) TO crmapp_app;
