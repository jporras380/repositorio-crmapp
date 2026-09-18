-- 0035 · Verificación en dos pasos (TOTP).
--
-- `users.mfa_secret_id` llevaba desde la fase 0 como hueco reservado, sin
-- tabla detrás. Aquí está la tabla.
--
-- ## Por qué sin `tenant_id` y sin RLS de inquilino
--
-- El segundo factor es de la PERSONA, no de la cuenta: la misma persona puede
-- estar en dos empresas y no va a llevar dos móviles. Además se comprueba al
-- iniciar sesión, cuando todavía no hay inquilino que poner en el contexto.
-- Se protege como las contraseñas: solo el rol de autenticación lo ve.
--
-- ## Por qué el secreto va cifrado
--
-- Quien lea esta tabla puede generar códigos válidos para siempre. Va con el
-- mismo sobre que las credenciales de canal (ARCH §11): clave de datos
-- envuelta con la maestra, que no vive en la base.

CREATE TABLE user_mfa (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  ciphertext   bytea       NOT NULL,
  dek_wrapped  bytea       NOT NULL,
  key_version  integer     NOT NULL,
  -- Hasta que no se confirma con un código, no protege nada: alguien podría
  -- quedar fuera de su cuenta por un secreto que nunca llegó a guardar.
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Códigos de recuperación: el móvil se pierde, se rompe y se formatea. Sin
-- esto, perder el teléfono es perder la cuenta, y el CRM no tiene a nadie a
-- quien llamar para recuperarla.
--
-- Se guardan HASHEADOS, como las contraseñas: quien lea la tabla no entra.
CREATE TABLE user_mfa_recovery (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  text        NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_mfa_recovery_usuario_idx ON user_mfa_recovery (user_id) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa TO crmapp_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa_recovery TO crmapp_auth;

-- ## Por qué se va `users.mfa_secret_id`
--
-- Era un hueco reservado en fase 0 para un diseño que no llegó a existir (el
-- secreto guardado en una tabla genérica de secretos). Nadie lo escribió
-- nunca: está a NULL en todas las filas. Dejarlo ahora significaría DOS
-- sitios donde preguntar «¿esta persona tiene segundo factor?», y la
-- respuesta podría diferir — que es justo el tipo de fallo que costó cuatro
-- arreglos esta semana. La verdad vive en `user_mfa.confirmed_at`, sola.
ALTER TABLE users DROP COLUMN mfa_secret_id;
