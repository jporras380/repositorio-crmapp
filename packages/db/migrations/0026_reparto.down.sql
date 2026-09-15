-- Reversa de 0026. Las asignaciones ya hechas se conservan: viven en
-- `conversations.assignee_user_id` desde 0004.
ALTER TABLE memberships DROP COLUMN IF EXISTS accepts_assignments;
ALTER TABLE tenants DROP COLUMN IF EXISTS auto_assignment;
