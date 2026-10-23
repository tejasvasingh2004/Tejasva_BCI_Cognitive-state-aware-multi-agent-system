import { expect, test } from '@playwright/test';

const HOOK = `http://127.0.0.1:${process.env.E2E_HOOK_PORT ?? 8099}/hook`;

test('Webhooks: add an endpoint, send a test delivery, see it delivered, reveal the secret, remove it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Webhooks' }).click();
  await expect(settings).toContainText('No endpoints yet.');

  await settings.getByTestId('webhook-url').fill(HOOK);
  await settings.getByTestId('webhook-event-run.completed').click();
  await settings.getByTestId('webhook-add').click();
  const row = settings.getByTestId('webhook-row');
  await expect(row).toContainText(HOOK);
  await expect(row).toContainText('Run completed');

  // A test delivery is signed and sent by the worker; the log shows it delivered (HTTP 204).
  await row.getByTestId('webhook-test').click();
  const delivery = settings.getByTestId('webhook-delivery').first();
  await expect(delivery).toContainText('delivered', { timeout: 15_000 });
  await expect(delivery).toContainText('webhook.test');
  await expect(row).toContainText('last delivered (204)');

  await settings.getByTestId('webhook-secret-reveal').click();
  await expect(settings.getByTestId('webhook-secret')).toContainText('whsec_');

  await row.getByTestId('webhook-toggle').click();
  await expect(row).toContainText('paused');
  await row.getByTestId('webhook-delete').click();
  await expect(settings.getByTestId('webhook-row')).toHaveCount(0);
});
