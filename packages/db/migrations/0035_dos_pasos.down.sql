-- Reversa de 0035. Quien tuviera segundo factor entra solo con contraseña:
-- se pierde protección, no acceso.
-- El hueco vuelve vacío, que es como estuvo siempre.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_id uuid;

DROP TABLE IF EXISTS user_mfa_recovery;
DROP TABLE IF EXISTS user_mfa;
