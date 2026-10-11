import { expect, test } from '@playwright/test';

/**
 * Product Phase 2 in the browser, against the real stack (API → BullMQ → worker → orchestrator →
 * Model Gateway → Tool Runtime → Git + Docker sandbox). GitHub's REST API is mocked; the
 * repository, clone, edits, tests, commit and push are real.
 */
test.describe.configure({ mode: 'serial' });

test('GitHub → repository → workspace → Code Agent → review → tests → commit → push → PR → replay', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/code');
  await expect(page.getByRole('heading', { name: 'Open a repository' })).toBeVisible();

  // Connect GitHub with a token; it never comes back to the browser.
  await page.getByTestId('connect-token').click();
  await page.getByTestId('github-token').fill('ghp_e2e_test_token_0000000001');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('button', { name: /octo/ }).first()).toBeVisible();

  // Account/organization → repository → branch → approval mode → create.
  await page.getByRole('button', { name: 'acme', exact: true }).click();
  await page.getByTestId('repo-list').getByText('calc', { exact: true }).click();
  await expect(page.getByTestId('branch-select')).toHaveValue('main');
  await page.getByTestId('create-workspace').click();
  await expect(page).toHaveURL(/\/code\/[0-9a-f-]{36}$/);

  // The worker clones the repository; the explorer shows its files.
  await expect(page.getByTestId('repo-name')).toHaveText('acme/calc');
  await expect(page.getByTestId('explorer')).toContainText('src', { timeout: 60_000 });
  await page.getByTestId('explorer').getByText('src', { exact: true }).click();
  await page.getByTestId('file-src/math.js').click();
  const editor = page.locator('[data-testid="editor-area"] .monaco-editor .view-lines');
  await expect(editor).toContainText('return a - b', { timeout: 30_000 });

  // Ask the Code Agent; in Review mode the patch waits for approval.
  await page.getByTestId('agent-input').fill('Fix the failing add test');
  await page.getByTestId('agent-send').click();
  const review = page.getByTestId('agent-panel').getByTestId('patch-review').first();
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(review.getByTestId('diff-view')).toContainText('return a + b');
  // Nothing is applied before approval.
  await expect(editor).toContainText('return a - b');
  await review.getByTestId('approve-patch').click();

  // Applied → the open editor follows the workspace → validation runs the tests in the sandbox.
  await expect(editor).toContainText('return a + b', { timeout: 60_000 });
  await page.getByTestId('agent-chat').click();
  await expect(page.getByTestId('agent-thread')).toContainText('Fixed add()', { timeout: 180_000 });
  await page.getByTestId('agent-activity').click();
  await expect(page.getByTestId('activity-list')).toContainText('Read src/math.js');
  await expect(page.getByTestId('activity-list')).toContainText(/Tests passed/);
  await page.getByTestId('agent-plan').click();
  await expect(page.getByTestId('agent-panel')).toContainText('Fix add()');

  // Git Diff → commit (moves to a neuroflow/agent/* branch) → push → pull request.
  await page.getByTestId('bottom-diff').click();
  await expect(page.getByTestId('git-diff')).toContainText('return a + b');
  await page.getByTestId('commit-message').fill('Fix add() to add its arguments');
  await page.getByTestId('commit').click();
  await expect(page.getByText(/Committed [0-9a-f]{7}/)).toBeVisible();
  await expect(page.getByTestId('branch-name')).toContainText('neuroflow/agent/');
  await expect(page.getByTestId('git-diff')).toContainText('Working tree clean');
  await page.getByTestId('push').click();
  await expect(page.getByText(/Pushed neuroflow\/agent\//)).toBeVisible();
  await page.getByTestId('open-pr').click();
  await page.getByTestId('pr-title').fill('Fix add()');
  await page.getByTestId('create-pr').click();
  await expect(page.getByText('Pull request #12 opened')).toBeVisible();

  // Terminal: a user command runs in the sandbox and streams back.
  await page.getByTestId('bottom-terminal').click();
  await page.getByTestId('terminal-input').fill('node --version');
  await page.getByTestId('terminal-input').press('Enter');
  await expect(page.getByTestId('terminal-output')).toContainText(/v\d+\.\d+/, { timeout: 60_000 });

  // Command bar: go to file.
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-input').fill('README');
  await page.getByTestId('command-input').press('Enter');
  await expect(page.getByTestId('tab-README.md')).toBeVisible();

  // Replay reads recorded history only.
  await page.getByTestId('agent-chat').click();
  await page.getByTestId('open-replay').first().click();
  await expect(page.getByTestId('replay-view')).toContainText('Recorded history');
  await expect(page.getByTestId('replay-activity')).toContainText('Patch approved');
  await expect(page.getByTestId('replay-view')).toContainText('return a + b');
});

test('Plan Review: edit and approve the agent plan before it touches the repository', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/code');
  await page.getByTestId('workspace-list').getByText('acme/calc').first().click();
  await expect(page.getByTestId('explorer')).toContainText('src', { timeout: 60_000 });
  await page.getByTestId('plan-first').click();
  await expect(page.getByTestId('plan-first')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('agent-input').fill('Make add() easier to understand');
  await page.getByTestId('agent-send').click();

  const review = page.getByTestId('plan-review');
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(review.getByTestId('plan-step-0')).toHaveValue('Read src/math.js');
  await review.getByTestId('plan-step-1').fill('Fix add() and keep it a one-liner');
  await review.getByTestId('plan-add-step').click();
  await review.getByTestId('plan-step-3').fill('Summarise the change for the reviewer');
  await expect(review.getByTestId('plan-approve')).toHaveText(/Approve edited plan/);
  await review.getByTestId('plan-approve').click();

  await page.getByTestId('agent-chat').click();
  await expect(page.getByTestId('agent-thread')).toContainText('Fixed add()', { timeout: 120_000 });
  await page.getByTestId('agent-activity').click();
  await expect(page.getByTestId('activity-list')).toContainText('You approved an edited plan');
  await page.getByTestId('agent-plan').click();
  await expect(page.getByTestId('agent-panel')).toContainText('Summarise the change for the reviewer');
  await expect(page.getByTestId('agent-panel')).toContainText('Approved by you');
});

test('Model Lab: providers state fine-tuning honestly; deployments, datasets and evaluations work', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/lab/providers');
  await expect(page.getByTestId('lab-provider').first()).toBeVisible();
  await expect(page.getByText('Fine-tuning not available').first()).toBeVisible();

  await page.getByTestId('lab-fine-tuning').click();
  await expect(page.getByText(/no training jobs can be started here/)).toBeVisible();

  await page.getByTestId('lab-deployments').click();
  await page.getByTestId('deployment-name').fill('e2e-bot');
  await page.getByLabel('Model', { exact: true }).selectOption('qwen/qwen3:8b');
  await page.getByTestId('save-deployment').click();
  await expect(page.getByTestId('deployment')).toContainText('deployment/e2e-bot');

  await page.getByTestId('lab-datasets').click();
  await page.getByTestId('dataset-name').fill('E2E set');
  await page.getByTestId('dataset-name').press('Enter');
  await page.getByTestId('example-task').fill('What is NeuroFlow?');
  await page.getByPlaceholder('Expected answer (used by evaluations)').fill('mock answer');
  await page.getByTestId('add-example').click();
  await expect(page.getByText('What is NeuroFlow?')).toBeVisible();

  await page.getByTestId('lab-evaluations').click();
  await page.getByTestId('eval-dataset').selectOption({ label: 'E2E set (1)' });
  await page.getByRole('button', { name: 'qwen/qwen3:8b' }).click();
  await page.getByTestId('run-evaluation').click();
  await expect(page.getByTestId('evaluation').first()).toContainText('completed', { timeout: 60_000 });
  await expect(page.getByTestId('evaluation').first()).toContainText('100%');
});
