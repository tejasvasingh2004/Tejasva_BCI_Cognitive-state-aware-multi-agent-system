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
