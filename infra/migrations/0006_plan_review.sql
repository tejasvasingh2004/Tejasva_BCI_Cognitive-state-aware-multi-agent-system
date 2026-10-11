-- Plan Review: the user's decision on the Code Agent's plan is recorded like other approvals.
ALTER TABLE code_approvals DROP CONSTRAINT IF EXISTS code_approvals_subject_type_check;
ALTER TABLE code_approvals
  ADD CONSTRAINT code_approvals_subject_type_check
  CHECK (subject_type IN ('patch', 'command', 'delete', 'commit', 'push', 'pull_request', 'plan', 'other'));
