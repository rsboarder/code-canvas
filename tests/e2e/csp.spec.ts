import { expect, test } from "@playwright/test";

import {
  bodyPoint,
  collectBrowserErrors,
  expectHighlighted,
  installDirectoryMock,
  openFolder,
} from "./support";

interface SecurityPolicyViolation {
  readonly violatedDirective: string;
  readonly blockedURI: string;
}

type Page = Parameters<typeof installDirectoryMock>[0];

async function installViolationCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as Window & {
      __cspViolations?: SecurityPolicyViolation[];
    };
    state.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      state.__cspViolations?.push({
        violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI,
      });
    });
  });
}

async function readViolations(
  page: Page,
): Promise<readonly SecurityPolicyViolation[]> {
  return page.evaluate(() => {
    const state = window as Window & {
      __cspViolations?: SecurityPolicyViolation[];
    };
    return state.__cspViolations ?? [];
  });
}

test.use({ deviceScaleFactor: 2 });

test("Third-party script and font sources are blocked", async ({ page }) => {
  await installViolationCollector(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const script = document.createElement("script");
    script.src = "https://example.com/blocked.js";
    document.head.append(script);

    const font = new FontFace(
      "Blocked",
      "url(https://example.com/blocked.woff2)",
    );
    document.fonts.add(font);
    await font.load().catch(() => undefined);
  });

  await expect
    .poll(async () => {
      const violations = await readViolations(page);
      return {
        hasScriptViolation: violations.some(
          (violation) =>
            violation.violatedDirective.startsWith("script-src") &&
            violation.blockedURI.includes("example.com"),
        ),
        hasFontViolation: violations.some(
          (violation) =>
            violation.violatedDirective.startsWith("font-src") &&
            violation.blockedURI.includes("example.com"),
        ),
      };
    })
    .toEqual({ hasScriptViolation: true, hasFontViolation: true });

  const violations = await readViolations(page);
  expect(violations, `CSP violations: ${JSON.stringify(violations)}`).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        violatedDirective: expect.stringMatching(/^script-src/),
        blockedURI: expect.stringContaining("example.com"),
      }),
      expect.objectContaining({
        violatedDirective: expect.stringMatching(/^font-src/),
        blockedURI: expect.stringContaining("example.com"),
      }),
    ]),
  );
});

test("A session runs without Content Security Policy violations", async ({
  page,
}) => {
  await installViolationCollector(page);
  const browserErrors = collectBrowserErrors(page);
  const text = Array.from(
    { length: 40 },
    (_, index) => `const line${String(index)} = ${String(index)};`,
  ).join("\n");
  await installDirectoryMock(page, text);
  await page.goto("/");
  await openFolder(page);
  await expectHighlighted(page, browserErrors);

  const canvas = page.getByTestId("canvas");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-editing", "false");

  const violations = await readViolations(page);
  expect(violations, `CSP violations: ${JSON.stringify(violations)}`).toEqual(
    [],
  );
  const cspErrors = browserErrors.filter((error) =>
    error.includes("Content Security Policy"),
  );
  expect(cspErrors, `Browser errors: ${browserErrors.join("\n")}`).toEqual([]);
});
