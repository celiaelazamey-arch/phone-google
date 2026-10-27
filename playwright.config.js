import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 2,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: process.env.PLAYWRIGHT_CHROMIUM_ARGS
        ? JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS)
        : [],
    },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node src/celia-mcp.js",
      url: "http://127.0.0.1:3100/health",
      reuseExistingServer: false,
      env: {
        NODE_ENV: "test",
        CELIA_MCP_PORT: "3100",
        CELIA_MCP_HOST: "0.0.0.0",
        CELIA_MCP_DISABLE_MYSQL: "true",
        CELIA_MCP_API_TOKEN: "e2e-only-not-a-production-token-0000000000",
        CELIA_DISABLE_OLLAMA: "true",
        GEMINI_API_KEY: "",
      },
    },
    {
      command: "npm run build:pages && node scripts/serve-pages.mjs",
      url: "http://127.0.0.1:3101/phone-google/system.html",
      reuseExistingServer: false,
      env: { PORT: "3101", CELIA_PAGES_BASE_PATH: "/phone-google/" },
    },
  ],
});
