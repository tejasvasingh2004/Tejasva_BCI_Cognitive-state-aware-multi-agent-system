-- Dollar budgets: a workspace's daily and monthly model-spend limits, and a monthly limit per
-- workspace provider key. Spend is summed from model_calls.cost_usd, so each call records which
-- workspace and which provider key (if any) it was charged to.
CREATE TABLE workspace_budgets (
  workspace_id       uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  monthly_limit_usd  numeric(12, 2) CHECK (monthly_limit_usd > 0),
  daily_limit_usd    numeric(12, 2) CHECK (daily_limit_usd > 0),
  alert_percent      integer NOT NULL DEFAULT 80 CHECK (alert_percent BETWEEN 1 AND 100),
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE provider_keys ADD COLUMN monthly_budget_usd numeric(12, 2) CHECK (monthly_budget_usd > 0);

ALTER TABLE model_calls ADD COLUMN workspace_id uuid;
ALTER TABLE model_calls ADD COLUMN provider_key_id uuid;
UPDATE model_calls mc SET workspace_id = r.workspace_id FROM runs r WHERE r.id = mc.run_id AND mc.workspace_id IS NULL;
CREATE INDEX model_calls_workspace_spend_idx ON model_calls (workspace_id, created_at);
CREATE INDEX model_calls_key_spend_idx ON model_calls (provider_key_id, created_at) WHERE provider_key_id IS NOT NULL;
