import { defineConfig, devices } from "@playwright/test";

// The same built app, served by the real harness web server (src/artifacts/server.ts) over a fake harness
// (src/console2/dev-server.ts). The mock-backed suite proves the UI; this one proves it works with the real API
// and the real Content-Security-Policy.
const PORT = 4021;

export default defineConfig({
  testDir: "e2e-real",
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  webServer: {
    command: `npm run build && node --experimental-strip-types ../../src/console2/dev-server.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}/console2/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
