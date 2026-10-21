-- Usage history: runs of a workspace by creation time (usage page, quotas and, later, billing).
CREATE INDEX IF NOT EXISTS runs_workspace_created_idx ON runs (workspace_id, created_at DESC);
