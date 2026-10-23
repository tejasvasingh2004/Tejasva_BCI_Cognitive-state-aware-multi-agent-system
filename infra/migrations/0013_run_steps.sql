-- Durable steps: every completed model call of a run is a checkpoint. A run interrupted by a worker
-- crash or shutdown resumes on another worker and replays these instead of calling the model again.
CREATE TABLE run_steps (
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_key    text NOT NULL,
  kind        text NOT NULL,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_key)
);
