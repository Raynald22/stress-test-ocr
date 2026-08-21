import { defineConfig, devices } from '@playwright/test';

// Browser journey for FE validation — a FEW concurrent users (workers), NOT a
// load test. For load use the k6 API-replay journeys one level up.
export default defineConfig({
  testDir: '.',
  timeout: 5 * 60 * 1000,          // OCR path can be slow
  expect: { timeout: 30_000 },
  // "concurrent users" = workers running repeated instances of the single
  // journey test. Without repeatEach there's only 1 test case, so USERS
  // would have nothing to parallelize. Keep small; real browsers are heavy.
  workers: Number(process.env.USERS || 3),
  repeatEach: Number(process.env.USERS || 3),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.FE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
