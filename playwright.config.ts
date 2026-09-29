import { defineConfig } from "@playwright/test";

function checkoutPort(): number {
  const checkout = process.cwd();
  const hash = Array.from(checkout).reduce<number>(
    (value, character) => (value * 31 + (character.codePointAt(0) ?? 0)) % 1000,
    0,
  );
  return 5173 + hash;
}

const port = Number(process.env.PLAYWRIGHT_PORT ?? checkoutPort());

export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: `http://127.0.0.1:${String(port)}`,
    channel: "chrome",
  },
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${String(port)} --strictPort`,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    url: `http://127.0.0.1:${String(port)}`,
  },
});
