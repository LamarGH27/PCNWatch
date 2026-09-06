import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests that need real data behind them.
 *
 * The main suite runs with no credentials on purpose. The map hides itself
 * entirely in that state — correctly — so anything that has to interact with
 * the map cannot be proven there. This config points at a server started
 * against a migrated database with Camden locations in it.
 *
 * Driven by `npm run test:e2e:data`, which starts that server.
 */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = existsSync(PREINSTALLED_CHROMIUM)
  ? { executablePath: PREINSTALLED_CHROMIUM }
  : {};

export default defineConfig({
  testDir: './tests/e2e-data',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  timeout: 45_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3211',
    trace: 'on-first-retry',
    launchOptions,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions } }],
});
