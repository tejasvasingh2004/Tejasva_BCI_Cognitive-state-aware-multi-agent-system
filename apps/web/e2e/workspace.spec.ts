import { expect, test, type Page } from '@playwright/test';

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send-button').click();
}

const lastTurn = (page: Page) => page.getByTestId('assistant-turn').last();

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /NeuroFlow/ })).toBeVisible();
});

test('simple question: immediate acknowledgement, live status, streamed answer, completion', async ({ page }) => {
  await ask(page, 'hello there');
  await expect(page.getByTestId('user-message').last()).toHaveText('hello there');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('assistant-text')).toContainText('NeuroFlow mock answer to: hello there');
  await expect(turn.getByTestId('execution-trace')).toHaveAttribute('data-status', 'completed');
  await expect(turn.getByTestId('run-phase')).toHaveText('Completed');
  // The URL is durable: reloading shows the persisted conversation.
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(lastTurn(page).getByTestId('assistant-text')).toContainText('NeuroFlow mock answer to: hello there');
});

test('execution timeline and inspector reflect real backend events', async ({ page }) => {
  await ask(page, 'Explain the core idea');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('execution-trace')).toHaveAttribute('data-status', 'completed');
  await turn.getByTestId('execution-trace').locator('button').first().click();
  await expect(turn.getByTestId('timeline')).toContainText('Selecting execution strategy');
  await turn.getByText('Inspect').click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('Strategy');
  await expect(inspector).toContainText('qwen3:8b');
  await expect(inspector).toContainText(/completed/i);
});

test('memory: user-managed memory is retrieved through the search_memory tool', async ({ page }) => {
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByTestId('memory-input').fill('We decided pricing is $29 per seat');
  await page.getByRole('button', { name: 'Remember' }).click();
  await expect(page.getByText('We decided pricing is $29 per seat')).toBeVisible();
  await page.keyboard.press('Escape');

  await ask(page, 'What did I decide about pricing?');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('assistant-text')).toContainText('$29');
  await expect(turn.getByText('search_memory')).toBeVisible();
});

test('tool call: calculator result flows back to the model', async ({ page }) => {
  await ask(page, 'Please calculate 12*(3+4)');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('assistant-text')).toContainText('84');
  await expect(turn.getByText('calculator')).toBeVisible();
});

test('cancellation: Stop halts a running task', async ({ page }) => {
  await ask(page, 'please be slow');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('assistant-text')).toBeVisible();
  await page.getByTestId('stop-button').click();
  await expect(turn.getByTestId('run-stopped')).toBeVisible();
  await expect(turn.getByTestId('execution-trace')).toHaveAttribute('data-status', 'cancelled');
  await expect(page.getByTestId('send-button')).toBeVisible();
});

test('provider failure is reported clearly with retry', async ({ page }) => {
  await ask(page, 'trigger provider failure please');
  const error = lastTurn(page).getByTestId('run-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('unavailable');
  await expect(error.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('cognitive mode: workload shapes the plan; standard mode is unaffected', async ({ page }) => {
  await page.getByLabel('Execution controls').click();
  await page.getByTestId('mode-toggle').click();
  await page.getByTestId('cognitive-pill').click();
  await page.getByRole('menuitem', { name: /Overloaded/ }).click();
  await expect(page.getByTestId('cognitive-pill')).toContainText('concise');

  await ask(page, 'Give me a comprehensive, in-depth plan:\n1. hiring\n2. pricing\n3. launch\n4. risks');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('execution-trace')).toHaveAttribute('data-status', 'completed');
  // High workload uses minimal UI density: the per-message trace is reduced, so use the top bar.
  await expect(turn.getByText('Inspect')).toHaveCount(0);
  await page.getByTestId('inspector-toggle').click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toContainText('Cognitive policy');
  await expect(inspector).toContainText(/capped strategy at "single_agent"/);

  // back to standard mode
  await page.getByTestId('cognitive-pill').click();
  await page.getByRole('menuitem', { name: 'Switch to Standard mode' }).click();
  await expect(page.getByTestId('cognitive-pill')).toContainText('Standard mode');
});

test('invalid tool arguments are rejected by validation and reported, never executed', async ({ page }) => {
  await ask(page, 'please make a broken tool call');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('execution-trace')).toHaveAttribute('data-status', 'completed');
  await expect(turn.getByTestId('assistant-text')).toContainText('invalid_arguments');
  await turn.getByText('Inspect').click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toContainText('calculator');
  await expect(inspector).toContainText('invalid argument');
});

test('a tool outside the selected tools is denied by authorization', async ({ page }) => {
  await page.getByLabel('Execution controls').click();
  await page.getByTestId('tools-picker').click();
  await page.getByRole('menuitem', { name: 'No tools' }).click();
  await page.getByTestId('tools-picker').click();
  await page.getByRole('menuitem', { name: /calculator/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tools-picker')).toContainText('calculator');

  await ask(page, 'use the forbidden tool please');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('execution-trace')).toHaveAttribute('data-status', 'completed');
  await turn.getByText('Inspect').click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toContainText('get_current_time');
  await expect(inspector).toContainText('outside its allowed or authorised tools');

  // restore
  await page.getByTestId('tools-picker').click();
  await page.getByRole('menuitem', { name: 'All available tools' }).click();
});

test('multi-agent, multi-model execution is visible in the execution graph', async ({ page }) => {
  await page.getByLabel('Execution controls').click();
  await page.getByTestId('strategy-picker').click();
  await page.getByRole('menuitem', { name: 'Sequential agents' }).click();
  await ask(page, 'Research the trade-offs of event sourcing');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('execution-trace')).toHaveAttribute('data-status', 'completed');
  await turn.getByText('Inspect').click();
  const graph = page.getByTestId('execution-graph');
  await expect(graph).toContainText('agent researcher');
  await expect(graph).toContainText('agent analyst');
  await expect(graph).toContainText('agent writer');
  // Roles were spread across both providers.
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toContainText(/multi-model/i);
  await expect(inspector).toContainText('qwen3:8b');
  await expect(inspector).toContainText('llama-3.3-70b-versatile');

  await page.getByTestId('strategy-picker').click();
  await page.getByRole('menuitem', { name: /Auto \(smallest reliable\)/ }).click();
});

test('settings: a custom agent can be created and chosen in the composer; theme switches', async ({ page }) => {
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Agents' }).click();
  await settings.getByRole('button', { name: 'New agent' }).click();
  await settings.getByPlaceholder('id (e.g. code-reviewer)').fill('reviewer');
  await settings.getByPlaceholder('Name').fill('Reviewer');
  await settings.getByPlaceholder('What it is good at (shown to the supervisor)').fill('Reviews code for bugs');
  await settings.getByPlaceholder('Instructions').fill('You are a meticulous code reviewer.');
  await settings.getByRole('button', { name: 'Save agent' }).click();
  await expect(settings).toContainText('Reviews code for bugs');

  await settings.getByRole('button', { name: 'General' }).click();
  await settings.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await settings.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.keyboard.press('Escape');

  await page.getByLabel('Execution controls').click();
  await page.getByTestId('agent-picker').click();
  await page.getByRole('menuitem', { name: /Reviewer/ }).click();
  await ask(page, 'Review this function');
  const turn = lastTurn(page);
  await expect(turn.getByTestId('execution-trace')).toHaveAttribute('data-status', 'completed');
  await turn.getByText('Inspect').click();
  await expect(page.getByTestId('execution-graph')).toContainText('agent reviewer');

  await page.getByTestId('agent-picker').click();
  await page.getByRole('menuitem', { name: 'Automatic' }).click();
});
