-- Reversa de 0042. Se pierde el historial de quién entró a dar soporte y
-- cuándo; hay que decirlo, porque es justo el registro que protege al cliente.
REVOKE ALL ON conversations, messages, contacts, contact_identities,
              channel_accounts, media_assets, flow_runs, flow_run_steps,
              support_grants
  FROM crmapp_soporte;
REVOKE ALL ON SCHEMA public, app FROM crmapp_soporte;

DROP POLICY IF EXISTS operador_pide ON support_grants;
DROP POLICY IF EXISTS operador_soporte ON support_grants;
DROP TABLE IF EXISTS support_grants;

-- El rol no se borra: puede tener concesiones en otra base del clúster, y un
-- DROP ROLE a medias deja la migración rota.
