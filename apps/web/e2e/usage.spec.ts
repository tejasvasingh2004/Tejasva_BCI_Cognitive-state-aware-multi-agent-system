import { expect, test } from '@playwright/test';

test('Usage: plan limits, today\'s quota and history update after a run', async ({ page }) => {
  // Make sure there is at least one recorded run with model usage.
  await page.goto('/');
  await page.getByTestId('composer-input').fill('usage page check');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('assistant-turn').last().getByTestId('execution-trace')).toHaveAttribute('data-status', 'completed');

  await page.getByTestId('app-usage').click();
  await expect(page).toHaveURL(/\/usage$/);
  const usage = page.getByTestId('usage-page');
  await expect(usage).toBeVisible();
  await expect(usage).toContainText(/team plan/i);
  await expect(page.getByTestId('usage-quota')).toContainText('Model tokens today');

  // Totals and the daily chart reflect recorded runs.
  await expect(usage).not.toContainText('No runs in the last');
  await expect(page.getByTestId('usage-total-tokens')).toBeVisible();
  await expect(page.getByTestId('usage-day')).toHaveCount(30);
  await page.getByTestId('usage-window-7').click();
  await expect(page.getByTestId('usage-day')).toHaveCount(7);
  await expect(page.getByTestId('usage-models')).toContainText('qwen3:8b');
  await expect(page.getByTestId('usage-sources')).toContainText('Chat');

  // Keyboard readout on the chart, then the table view carries every value.
  await page.getByTestId('usage-chart').focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('usage-tooltip')).toBeVisible();
  await page.getByTestId('usage-metric-cost').click();
  await page.getByTestId('usage-table-toggle').click();
  await expect(page.getByTestId('usage-daily-table').locator('tbody tr')).toHaveCount(7);
});
