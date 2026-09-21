import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 120_000,
  use: {
    browserName: 'chromium',
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
});
