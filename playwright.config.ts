import { defineConfig, devices } from "@playwright/test";

// Smoke tests of phase 1 against `wrangler dev` with a fresh local database
// (scripts/e2e-server.sh). See e2e/README.md.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8788",
    locale: "en-ZA",
    timezoneId: "Africa/Johannesburg",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "sh scripts/e2e-server.sh",
    url: "http://localhost:8788/login",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
