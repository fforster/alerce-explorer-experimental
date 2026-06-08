import { defineConfig, devices } from "@playwright/test";

// Tier 3 end-to-end tests. The app is started by Playwright with the upstream
// replay transport pointed at the recorded fixtures (tests-e2e/fixtures/
// upstream), so every ALeRCE/catsHTM call is served offline and
// deterministically. Browser-direct external calls (Aladin CDN, IRSA dust,
// VizieR, stamp images) are blocked per-test by the offline guard in
// tests-e2e/helpers.js — the app is designed to degrade gracefully without
// them, and the core search / detail / light-curve flow does not depend on
// them.
// Uncommon port to avoid colliding with other local dev servers / Docker
// containers; reuseExistingServer would otherwise silently bind the test run
// to a foreign app already listening here.
const PORT = 8743;

export default defineConfig({
  testDir: "tests-e2e/specs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `python3 -m uvicorn src.app:app --port ${PORT} --log-level warning`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      EXPLORER_REPLAY_DIR: "tests-e2e/fixtures/upstream",
      PYTHONPATH: ".",
      // Templates build absolute deferred-fetch URLs from API_URL; point it at
      // the test server so the LC/stamps/etc. fragments are same-origin (and
      // thus served from replay, not the default :8000).
      API_URL: `http://127.0.0.1:${PORT}`,
    },
  },
});
