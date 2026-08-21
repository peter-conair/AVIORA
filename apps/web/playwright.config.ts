import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

// CI passes these in the job env; a laptop keeps them in the repo's .env. The
// §72 journey test reads the invitation token from the outbox, which needs the
// database URL — everything else here runs without it.
dotenv.config({ path: [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '.env')] });

const WEB_PORT = Number(process.env.AVIORA_WEB_PORT ?? 3020);

/**
 * Browser E2E for the spec §72 journey. Runs at a phone viewport by default:
 * the product is mobile-first, so "usable at 360 px" is an assertion, not a
 * manual claim (docs/14 §3 row 18).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.AVIORA_WEB_URL ?? `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    port: WEB_PORT,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
