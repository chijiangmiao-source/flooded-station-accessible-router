import { defineConfig, devices } from '@playwright/test'

const previewPort = 4173

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${previewPort}`,
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chromium'] },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${previewPort} --host 0.0.0.0`,
    url: `http://localhost:${previewPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
