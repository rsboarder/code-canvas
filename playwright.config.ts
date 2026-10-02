import { defineConfig } from "@playwright/test";

// Chrome refuses to load these (net::ERR_UNSAFE_PORT); 6000 is the only one
// in the checkout port range 5173–6172.
const CHROME_UNSAFE_PORTS: ReadonlySet<number> = new Set([6000]);

function checkoutPort(): number {
  const checkout = process.cwd();
  const hash = Array.from(checkout).reduce<number>(
    (value, character) => (value * 31 + (character.codePointAt(0) ?? 0)) % 1000,
    0,
  );
  const port = 5173 + hash;
  return CHROME_UNSAFE_PORTS.has(port) ? port + 1 : port;
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
