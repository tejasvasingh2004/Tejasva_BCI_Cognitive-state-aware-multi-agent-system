-- Product Phase 2: AI Code Agent / AI IDE workspace and Model Lab.
-- Code runs are ordinary runs (runs table) with a code_runs extension row; every table is owned by a
-- tenant workspace (workspace_id) so isolation is explicit.

-- GitHub credentials. Tokens are encrypted at rest (AES-256-GCM) and never leave the server.
CREATE TABLE github_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('oauth', 'token')),
  github_login     text NOT NULL,
  github_user_id   bigint,
  token_encrypted  text NOT NULL,
  scopes           text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz
);
CREATE INDEX github_connections_ws_idx ON github_connections (workspace_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE repository_bindings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id    uuid REFERENCES github_connections(id) ON DELETE SET NULL,
  provider         text NOT NULL CHECK (provider IN ('github', 'local')),
  owner            text NOT NULL,
  name             text NOT NULL,
  default_branch   text NOT NULL,
  clone_url        text NOT NULL,
  html_url         text,
  private          boolean NOT NULL DEFAULT true,
  -- Repository access does not imply modification permission.
  can_push         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, owner, name)
);

CREATE TABLE code_workspaces (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id     uuid NOT NULL REFERENCES repository_bindings(id) ON DELETE CASCADE,
  created_by        uuid NOT NULL REFERENCES users(id),
  branch            text NOT NULL,
  base_branch       text NOT NULL,
  base_commit       text,
  head_commit       text,
  status            text NOT NULL CHECK (status IN ('provisioning', 'ready', 'syncing', 'error', 'archived')),
  error             text,
  approval_mode     text NOT NULL DEFAULT 'review' CHECK (approval_mode IN ('suggest', 'review', 'auto', 'restricted')),
  commands          jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX code_workspaces_ws_idx ON code_workspaces (workspace_id, updated_at DESC) WHERE status <> 'archived';

-- A code run is a run with repository context.
CREATE TABLE code_runs (
  run_id             uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  code_workspace_id  uuid NOT NULL REFERENCES code_workspaces(id) ON DELETE CASCADE,
  approval_mode      text NOT NULL CHECK (approval_mode IN ('suggest', 'review', 'auto', 'restricted')),
  base_commit        text,
  agent_branch       text,
  final_commit       text,
  files_changed      integer NOT NULL DEFAULT 0,
  additions          integer NOT NULL DEFAULT 0,
  deletions          integer NOT NULL DEFAULT 0,
  tests_passed       boolean,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX code_runs_ws_idx ON code_runs (code_workspace_id, created_at DESC);

-- Context actually given to the agent (active file, selection, pinned files, instructions).
CREATE TABLE code_context_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('active_file', 'selection', 'related_file', 'instructions', 'repository_map', 'file_read', 'search')),
  path        text,
  start_line  integer,
  end_line    integer,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX code_context_items_run_idx ON code_context_items (run_id);

CREATE TABLE code_patches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_workspace_id  uuid NOT NULL REFERENCES code_workspaces(id) ON DELETE CASCADE,
  run_id             uuid REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id       text,
  base_commit        text,
  files              jsonb NOT NULL,
  diff               text NOT NULL,
  summary            text,
  validation         text NOT NULL CHECK (validation IN ('valid', 'invalid')),
  validation_error   text,
  status             text NOT NULL CHECK (status IN ('proposed', 'review_required', 'approved', 'rejected', 'applied', 'failed', 'superseded')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  applied_at         timestamptz
);
CREATE INDEX code_patches_run_idx ON code_patches (run_id, created_at);
CREATE INDEX code_patches_ws_idx ON code_patches (code_workspace_id, created_at DESC);

-- Explicit human decisions on Code Agent actions (who decided what, and when).
CREATE TABLE code_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        uuid REFERENCES runs(id) ON DELETE CASCADE,
  subject_type  text NOT NULL CHECK (subject_type IN ('patch', 'command', 'delete', 'commit', 'push', 'pull_request', 'other')),
  subject_id    text,
  tool_call_id  text,
  decision      text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX code_approvals_run_idx ON code_approvals (run_id);

CREATE TABLE sandbox_executions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_workspace_id  uuid NOT NULL REFERENCES code_workspaces(id) ON DELETE CASCADE,
  run_id             uuid REFERENCES runs(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('command', 'test', 'lint', 'build', 'install')),
  command            text NOT NULL,
  image              text,
  network            text,
  status             text NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'timeout', 'cancelled', 'denied')),
  exit_code          integer,
  output             text NOT NULL DEFAULT '',
  truncated          boolean NOT NULL DEFAULT false,
  duration_ms        integer,
  triggered_by       text NOT NULL CHECK (triggered_by IN ('agent', 'user')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX sandbox_executions_ws_idx ON sandbox_executions (code_workspace_id, created_at DESC);
CREATE INDEX sandbox_executions_run_idx ON sandbox_executions (run_id);

CREATE TABLE test_executions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_execution_id    uuid NOT NULL REFERENCES sandbox_executions(id) ON DELETE CASCADE,
  run_id                  uuid REFERENCES runs(id) ON DELETE CASCADE,
  passed                  boolean NOT NULL,
  passed_count            integer,
  failed_count            integer,
  total_count             integer,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE git_operations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_workspace_id  uuid NOT NULL REFERENCES code_workspaces(id) ON DELETE CASCADE,
  run_id             uuid REFERENCES runs(id) ON DELETE SET NULL,
  kind               text NOT NULL CHECK (kind IN ('branch', 'commit', 'push', 'pull_request')),
  ref                text,
  sha                text,
  url                text,
  message            text,
  performed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX git_operations_ws_idx ON git_operations (code_workspace_id, created_at DESC);

CREATE TABLE pull_request_refs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_workspace_id  uuid NOT NULL REFERENCES code_workspaces(id) ON DELETE CASCADE,
  run_id             uuid REFERENCES runs(id) ON DELETE SET NULL,
  number             integer NOT NULL,
  url                text NOT NULL,
  title              text NOT NULL,
  head               text NOT NULL,
  base               text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Replay reads the persisted run event history; it never re-executes anything.
CREATE VIEW code_replay_events AS
  SELECT e.run_id, c.code_workspace_id, e.seq, e.type, e.data, e.created_at
    FROM run_events e JOIN code_runs c ON c.run_id = e.run_id;

-- Repository-scoped memories (architecture decisions, conventions) in addition to user memory.
ALTER TABLE memories ADD COLUMN repository_id uuid REFERENCES repository_bindings(id) ON DELETE CASCADE;

-- ---- Model Lab ----

-- Workspace-level model configuration per surface (e.g. "code_agent"): model, parameters, policies.
CREATE TABLE model_lab_configs (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope         text NOT NULL,
  config        jsonb NOT NULL,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, scope)
);

CREATE TABLE fine_tuning_datasets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Examples are only ever added by an explicit user action (never automatically).
CREATE TABLE fine_tuning_examples (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id      uuid NOT NULL REFERENCES fine_tuning_datasets(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('manual', 'import', 'agent_interaction', 'accepted_patch', 'rejected_patch', 'test_failure', 'successful_fix', 'conversation')),
  source_run_id   uuid REFERENCES runs(id) ON DELETE SET NULL,
  task            text NOT NULL,
  context         text,
  output          text NOT NULL,
  expected        text,
  outcome         text CHECK (outcome IN ('accepted', 'rejected', 'neutral')),
  reviewed        boolean NOT NULL DEFAULT false,
  added_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fine_tuning_examples_ds_idx ON fine_tuning_examples (dataset_id, created_at);

CREATE TABLE fine_tuning_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             text NOT NULL,
  provider         text NOT NULL,
  base_model       text NOT NULL,
  dataset_id       uuid NOT NULL REFERENCES fine_tuning_datasets(id),
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL CHECK (status IN ('queued', 'validating', 'running', 'succeeded', 'failed', 'cancelled')),
  provider_job_id  text,
  result_model     text,
  progress         real,
  metrics          jsonb NOT NULL DEFAULT '{}'::jsonb,
  error            text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Model evaluations: a dataset run against one or more models through the Model Gateway.
CREATE TABLE model_evaluations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  dataset_id    uuid NOT NULL REFERENCES fine_tuning_datasets(id) ON DELETE CASCADE,
  models        text[] NOT NULL,
  scorer        text NOT NULL CHECK (scorer IN ('contains', 'exact', 'judge')),
  status        text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  results       jsonb NOT NULL DEFAULT '[]'::jsonb,
  error         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

-- Deployments: named, versioned model configurations usable by runs ("deployment:<name>").
CREATE TABLE model_deployments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  model         text NOT NULL,
  parameters    jsonb NOT NULL DEFAULT '{}'::jsonb,
  description   text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
