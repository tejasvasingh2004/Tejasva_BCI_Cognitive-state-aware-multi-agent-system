-- Webhooks: signed event deliveries to customer URLs. Deliveries are a Postgres outbox: workers
-- claim due rows with SKIP LOCKED, send them and schedule retries, so nothing depends on Redis and
-- a delivery can be retried by resetting its row.
CREATE TABLE webhook_secrets (
  workspace_id          uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Sealed with SECRETS_KEY (workers must sign with it); never stored in plaintext.
  secret_ciphertext     text NOT NULL,
  hint                  text NOT NULL,
  -- After a rotation the previous secret also signs until previous_expires_at.
  previous_ciphertext   text,
  previous_expires_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url              text NOT NULL,
  description      text,
  event_types      text[] NOT NULL DEFAULT '{}',
  enabled          boolean NOT NULL DEFAULT true,
  disabled_reason  text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_workspace_idx ON webhook_endpoints (workspace_id) WHERE enabled;

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Null for a run's own callback URL (async runs).
  endpoint_id      uuid REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  run_id           uuid REFERENCES runs(id) ON DELETE SET NULL,
  url              text NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  lease_until      timestamptz,
  last_status_code integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'delivering');
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX webhook_deliveries_workspace_idx ON webhook_deliveries (workspace_id, created_at DESC);
