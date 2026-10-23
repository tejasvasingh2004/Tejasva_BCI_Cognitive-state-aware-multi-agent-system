import { expect, test } from '@playwright/test';

test('Model providers: add a workspace key, see it in use, check it, remove it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Model providers' }).click();

  const groq = settings.getByTestId('provider-groq');
  await expect(groq).toBeVisible();
  await expect(settings.getByTestId('provider-source-groq')).toHaveText("Using NeuroFlow's key");

  // The key field is a password field and the key never appears again after saving.
  const keyInput = settings.getByTestId('provider-key-input');
  await expect(keyInput).toHaveAttribute('type', 'password');
  await settings.getByTestId('provider-key-provider').selectOption('groq');
  await keyInput.fill('gsk_e2e_workspace_key_00001234');
  await settings.getByRole('textbox', { name: 'Label' }).fill('Team account');
  await settings.getByTestId('provider-key-save').click();

  await expect(settings.getByTestId('provider-source-groq')).toHaveText('Using your key …1234');
  const row = groq.getByTestId('provider-key-row');
  await expect(row).toContainText('Team account');
  await expect(row).toContainText('…1234');
  await expect(keyInput).toHaveValue('');
  await expect(settings).not.toContainText('gsk_e2e_workspace_key_00001234');

  // Saving the same key again is refused.
  await keyInput.fill('gsk_e2e_workspace_key_00001234');
  await settings.getByTestId('provider-key-save').click();
  await expect(settings.getByTestId('provider-key-error')).toContainText('already stored');

  await row.getByTestId('provider-key-verify').click();
  await expect(row).toContainText('not used yet');

  // A monthly budget for the key, shown against this month's spend through it.
  await expect(row.getByTestId('provider-key-spend')).toHaveText('$0.00 this month');
  await row.getByTestId('provider-key-budget').click();
  await row.getByTestId('provider-key-budget-input').fill('25');
  await row.getByTestId('provider-key-budget-save').click();
  await expect(row.getByTestId('provider-key-spend')).toHaveText('$0.00 / $25.00 this month');

  await row.getByTestId('provider-key-delete').click();
  await expect(groq.getByTestId('provider-key-row')).toHaveCount(0);
  await expect(settings.getByTestId('provider-source-groq')).toHaveText("Using NeuroFlow's key");
});
