-- Bring-your-own-key: workspaces store their own model provider keys, encrypted with envelope
-- encryption. Each workspace has a data key (DEK) wrapped by a key-encryption key (KEK: a KMS key,
-- or SECRETS_KEY until one is configured); provider keys are encrypted with the DEK, bound to their
-- workspace, provider and id. Plaintext keys never touch the database.
CREATE TABLE workspace_data_keys (
  workspace_id  uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  kek_id        text NOT NULL,
  wrapped_key   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_keys (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  label             text NOT NULL,
  ciphertext        text NOT NULL,
  -- Last four characters (display) and a keyed hash (duplicate detection); neither reveals the key.
  hint              text NOT NULL,
  fingerprint       text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid')),
  last_error        text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  last_verified_at  timestamptz,
  UNIQUE (workspace_id, provider, fingerprint)
);
CREATE INDEX provider_keys_active_idx ON provider_keys (workspace_id, provider, created_at DESC) WHERE status = 'active';
