-- Workspace Settings: per code-workspace defaults (model, plan review, sandbox image).
ALTER TABLE code_workspaces ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
