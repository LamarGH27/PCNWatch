import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Some environments ship a pre-installed Chromium whose build number does not
 * match the one this Playwright version would download. When that binary exists,
 * use it rather than failing or pulling a second browser down.
 */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = existsSync(PREINSTALLED_CHROMIUM)
  ? { executablePath: PREINSTALLED_CHROMIUM }
  : {};

/**
 * End-to-end tests run against a production build with NO credentials configured.
 *
 * That is deliberate: the most important behaviours to prove in a browser are the
 * honesty ones — that an unconfigured deployment says data is unavailable rather
 * than showing zeros, that private pages stay private, and that unreviewed
 * content is not published for search engines. Those are exactly the behaviours
 * that a credentialled environment would hide.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3210',
    trace: 'on-first-retry',
    launchOptions,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
    // The mobile project matters: much of this product is used outdoors, one-handed.
    { name: 'mobile', use: { ...devices['Pixel 7'], launchOptions } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npx next start -p 3210',
        url: 'http://127.0.0.1:3210',
        /*
         * Never reuse a server this run did not start.
         *
         * `!process.env.CI` looked like a local convenience and was a way to
         * test the wrong build. Two consecutive runs would attach to the first
         * one's server while it was shutting down — pages stopped rendering
         * mid-suite and tests timed out at twenty seconds against an app that
         * renders in one. The same defect in scripts/e2e-data.sh produced a
         * false pass and then a false failure earlier in this project's life.
         *
         * Owning the server costs a few seconds of startup and removes an
         * entire class of result that means nothing.
         */
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
