-- Reversa de 0029. Se pierde qué conversaciones estaban esperando a una
-- persona, pero no el hecho: cada relevo dejó su paso en `flow_run_steps`.
DROP INDEX IF EXISTS conversations_relevo_idx;
ALTER TABLE conversations
  DROP COLUMN IF EXISTS handoff_reason,
  DROP COLUMN IF EXISTS handoff_at;
