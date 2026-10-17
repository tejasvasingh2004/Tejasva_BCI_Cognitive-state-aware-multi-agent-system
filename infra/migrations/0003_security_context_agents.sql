-- Security (audit events, local passwords), workspace context and retention, custom agents,
-- cost accounting and client-tool results.

-- Locally managed accounts (scrypt hash: "scrypt$N$r$p$salt$hash"). NULL = cannot sign in with a password.
ALTER TABLE users ADD COLUMN password_hash text;

-- Workspace-level context and memory retention policy.
ALTER TABLE workspaces ADD COLUMN instructions text NOT NULL DEFAULT '';
ALTER TABLE workspaces ADD COLUMN memory_retention_days integer CHECK (memory_retention_days IS NULL OR memory_retention_days > 0);

-- Memory expiry (from an explicit TTL or the workspace retention policy).
ALTER TABLE memories ADD COLUMN expires_at timestamptz;
CREATE INDEX memories_expiry_idx ON memories (expires_at) WHERE deleted_at IS NULL AND expires_at IS NOT NULL;

-- Rolling conversation summary covering messages up to (and including) summary_upto_position.
ALTER TABLE conversations ADD COLUMN summary_upto_position bigint;

-- Custom agents: execution settings and output contract.
ALTER TABLE agents ADD COLUMN model_role text NOT NULL DEFAULT 'agent';
ALTER TABLE agents ADD COLUMN max_iterations integer NOT NULL DEFAULT 4;
ALTER TABLE agents ADD COLUMN output_contract jsonb;

-- Cost accounting and client-tool results.
ALTER TABLE model_calls ADD COLUMN cost_usd numeric(14, 6);
ALTER TABLE runs ADD COLUMN cost_usd numeric(14, 6);
ALTER TABLE runs ADD COLUMN output_tool_calls jsonb;

-- Tool call attribution for the execution graph.
CREATE INDEX tool_calls_agent_idx ON tool_calls (agent_execution_id);

-- Append-only audit trail of security-relevant actions. Never contains secrets or message content.
CREATE TABLE audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_via      text,
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  outcome        text NOT NULL CHECK (outcome IN ('success', 'failure')),
  ip             text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace_idx ON audit_events (workspace_id, created_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, created_at DESC);
