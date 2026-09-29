-- NeuroFlow initial schema.
-- Durable application/runtime state lives here; Redis only holds transient coordination state.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- array_to_string is only STABLE; generated columns need an IMMUTABLE expression.
CREATE FUNCTION nf_immutable_join(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, ' ') $$;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  owner_id    uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,          -- sha256 of the full key; plaintext is never stored
  scopes        text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_workspace_idx ON api_keys (workspace_id);

CREATE TABLE conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL DEFAULT 'New conversation',
  summary       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE INDEX conversations_workspace_idx ON conversations (workspace_id, updated_at DESC) WHERE archived_at IS NULL;

CREATE TABLE runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id      uuid REFERENCES conversations(id) ON DELETE SET NULL,
  user_id              uuid NOT NULL REFERENCES users(id),
  mode                 text NOT NULL CHECK (mode IN ('standard', 'cognitive')),
  status               text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  requested_agent_strategy  text NOT NULL,
  requested_model_strategy  text NOT NULL,
  selected_model       text,
  agent_strategy       text,               -- resolved by the router
  model_strategy       text,
  task_class           text,
  request_options      jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_plan       jsonb,
  output               text,
  error_code           text,
  error_message        text,
  error_stage          text,
  prompt_tokens        integer,
  completion_tokens    integer,
  idempotency_key      text,
  source               text NOT NULL DEFAULT 'workspace' CHECK (source IN ('workspace', 'api', 'openai')),
  attempt              integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  queued_at            timestamptz,
  started_at           timestamptz,
  completed_at         timestamptz,
  cancel_requested_at  timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX runs_conversation_idx ON runs (conversation_id, created_at);
CREATE INDEX runs_workspace_status_idx ON runs (workspace_id, status);
CREATE INDEX runs_active_idx ON runs (status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id           uuid REFERENCES runs(id) ON DELETE SET NULL,
  role             text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content          text NOT NULL,
  name             text,
  tool_calls       jsonb,
  tool_call_id     text,
  position         bigserial,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, position);

CREATE TABLE run_events (
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  type        text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE agents (
  id            text NOT NULL,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,   -- NULL = built-in
  name          text NOT NULL,
  description   text NOT NULL,
  instructions  text NOT NULL,
  capabilities  text[] NOT NULL DEFAULT '{}',
  tools         text[] NOT NULL DEFAULT '{}',
  model_policy  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agents_id_scope_idx ON agents (id, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE agent_executions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_id     text NOT NULL,
  role         text NOT NULL,
  model        text NOT NULL,
  status       text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  iterations   integer NOT NULL DEFAULT 0,
  output       text,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX agent_executions_run_idx ON agent_executions (run_id);

CREATE TABLE model_calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_execution_id  uuid REFERENCES agent_executions(id) ON DELETE SET NULL,
  role                text NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  status              text NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
  latency_ms          integer NOT NULL,
  first_token_ms      integer,
  prompt_tokens       integer,
  completion_tokens   integer,
  attempts            integer NOT NULL DEFAULT 1,
  fallback_from       text,
  finish_reason       text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_calls_run_idx ON model_calls (run_id);

CREATE TABLE tool_calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_execution_id  uuid REFERENCES agent_executions(id) ON DELETE SET NULL,
  tool_call_id        text NOT NULL,
  name                text NOT NULL,
  arguments           jsonb,
  status              text NOT NULL CHECK (status IN ('pending_approval', 'running', 'success', 'error', 'timeout', 'denied', 'cancelled')),
  risk_level          text,
  approval_status     text CHECK (approval_status IN ('not_required', 'pending', 'approved', 'denied', 'expired')),
  result              jsonb,
  error_code          text,
  error_message       text,
  attempts            integer NOT NULL DEFAULT 1,
  duration_ms         integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  UNIQUE (run_id, tool_call_id)
);

CREATE TABLE memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       text NOT NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  source        text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'agent', 'import')),
  source_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  search        tsvector GENERATED ALWAYS AS (
                  to_tsvector('english'::regconfig, content || ' ' || nf_immutable_join(tags))
                ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX memories_search_idx ON memories USING gin (search);
CREATE INDEX memories_workspace_idx ON memories (workspace_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_execution_id  uuid REFERENCES agent_executions(id) ON DELETE SET NULL,
  kind                text NOT NULL,
  iteration           integer NOT NULL DEFAULT 0,
  verdict             text NOT NULL CHECK (verdict IN ('passed', 'failed', 'needs_refinement')),
  score               real,
  issues              text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluations_run_idx ON evaluations (run_id);

CREATE TABLE cognitive_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  workload      text NOT NULL CHECK (workload IN ('low', 'medium', 'high')),
  confidence    real NOT NULL,
  source        text NOT NULL,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
