import { defineConfig, devices } from '@playwright/test';

const API_PORT = 8090;
const WEB_PORT = 5190;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'node --import tsx e2e/stack.ts',
      url: `http://127.0.0.1:${API_PORT}/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { E2E_API_PORT: String(API_PORT) },
    },
    {
      command: `node node_modules/vite/bin/vite.js --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { NEUROFLOW_API_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
