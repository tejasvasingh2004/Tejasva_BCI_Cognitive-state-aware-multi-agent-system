-- Subscription plan per workspace (tenant): drives rate limits, concurrency caps, daily token
-- quotas and queue priority. Set by an operator today (db CLI `set-plan`), by billing later.
ALTER TABLE workspaces
  ADD COLUMN plan text NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free', 'pro', 'team', 'enterprise'));
