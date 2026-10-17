-- Scopes of the principal that created the run. Tool authorization during execution (including
-- recovered/requeued attempts) uses exactly these scopes.
ALTER TABLE runs ADD COLUMN principal_scopes text[] NOT NULL DEFAULT '{}';
