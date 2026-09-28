import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:5173",
    channel: "chrome",
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1",
    reuseExistingServer: true,
    url: "http://127.0.0.1:5173",
  },
});
