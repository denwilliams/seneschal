import { defineConfig, devices } from "@playwright/test";

// The mock serves the built app (dist/) under a reverse-proxy-style prefix, so this also proves the app works below one.
const PORT = 4011;
const PREFIX = "/proxy/harness";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  // One at a time: the mock holds state (console actions change a run, and a test puts it back), so two workers would see each other's.
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}${PREFIX}/console2/`, ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  webServer: {
    command: "npm run build && node mock/server.mjs",
    env: { PORT: String(PORT), MOCK_PREFIX: PREFIX },
    url: `http://127.0.0.1:${PORT}${PREFIX}/console2/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
