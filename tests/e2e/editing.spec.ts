import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { generateEdgeCaseCorpus } from "../../fixtures/lib/dataset";
import {
  LineLayout,
  type LineMetrics,
} from "../../src/code-view/domain/line-layout";
import { splitSourceLines } from "../../src/shared/domain";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../../src/shared/pinch";
import {
  assertHeldExitFrames,
  type FrameLogEntry,
  lastFrameTick,
  readFrameLog,
  waitForFrame,
} from "./frame-log";
import {
  bodyPoint,
  installDirectoryMock,
  openFolder,
  readMockFile,
  readWidgetRects,
  scrollCanvas,
} from "./support";

test.describe.configure({ mode: "serial" });
test.use({ deviceScaleFactor: 2 });

interface WidgetBodyRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function openFile(page: Page, text: string): Promise<void> {
  await installDirectoryMock(page, text);
  await page.goto("/");
  await openFolder(page);
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-content-version",
    "1",
  );
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-highlighted",
    "true",
  );
}

async function installEscapeKeydownClock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="canvas"]',
    );
    if (!canvas) throw new Error("Canvas is missing");
    canvas.removeAttribute("data-escape-keydown-ms");
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          canvas.setAttribute(
            "data-escape-keydown-ms",
            String(performance.now()),
          );
        }
      },
      { capture: true, once: true },
    );
  });
}

async function assertHighlightingAfterEdit(
  page: Page,
  text: string,
  label: string,
): Promise<void> {
  await openFile(page, text);
  const canvas = page.getByTestId("canvas");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await page.keyboard.type("x");
  await installEscapeKeydownClock(page);
  const startTick = await lastFrameTick(page);
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-editing", "false");
  await expect(canvas).toHaveAttribute("data-content-version", "2");
  const exit = await waitForFrame(
    page,
    (entry) => entry.tick > startTick && !entry.editorVisible,
  );
  const highlighted = await waitForFrame(
    page,
    (entry) =>
      entry.tick >= exit.tick &&
      !entry.editorVisible &&
      entry.drawnTileCount > 0 &&
      entry.lowestContentVersion >= 2 &&
      entry.drawnUnhighlightedTileCount === 0,
  );
  const keydownAt = Number(await canvas.getAttribute("data-escape-keydown-ms"));
  if (!Number.isFinite(keydownAt))
    throw new Error("Escape keydown timestamp is missing");
  console.info(
    `Highlighting after an edit ${label}: escape-to-exit=${String(exit.timeMs - keydownAt)}ms, exit-to-highlight=${String(highlighted.timeMs - exit.timeMs)}ms`,
  );
  expect(highlighted.timeMs - exit.timeMs).toBeLessThanOrEqual(100);
  await assertHeldExitFrames(page, startTick, 2);
}

async function pinchWithCdp(page: Page, target: number): Promise<void> {
  const current = await cameraScale(page);
  let remainingLn = Math.log(target / current);
  const point = await page.evaluate(() => ({
    x: window.innerWidth - 24,
    y: window.innerHeight - 24,
  }));
  const client = await page.context().newCDPSession(page);
  while (Math.abs(remainingLn) > 1e-9) {
    const step =
      Math.sign(remainingLn) *
      Math.min(Math.abs(remainingLn), MAX_ZOOM_STEP_LN);
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: -step * PINCH_WHEEL_DELTA_PER_LN_SCALE,
      modifiers: 2,
    });
    remainingLn -= step;
  }
  await client.detach();
}

test("Double click on a line", async ({ page }) => {
  const text = Array.from(
    { length: 100 },
    (_, index) => `const line${String(index + 1)} = ${String(index + 1)};`,
  ).join("\n");
  await openFile(page, text);
  const canvas = page.getByTestId("canvas");
  const targetLineNumber = 42;
  const firstVisibleText = "const line41 = 41;";
  await scrollCanvas(page, DEFAULT_CODE_FONT.lineHeight * 80);
  await zoomCanvasTo(page, 1.37);
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  const viewLine = page.locator(".monaco-editor .view-line").first();
  await expect(viewLine).toBeVisible();
  await expect(viewLine).toContainText(firstVisibleText);
  const metrics = await page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    return hook.textMetrics();
  });
  const scale = Number(await canvas.getAttribute("data-text-metrics-scale"));
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-editing", "false");
  const line = metrics.lines[targetLineNumber - 1] ?? [];
  const targetIndex = 4;
  const targetCell = line[targetIndex];
  const nextCell = line[targetIndex + 1];
  if (!targetCell || !nextCell) throw new Error("Cursor probe cell is missing");
  const targetX = targetCell.x + (nextCell.x - targetCell.x) / 4;
  const codeTargetX = targetX - (line[0]?.x ?? 0);
  const advances = new Map<string, number>();
  for (let index = 0; index < line.length - 1; index += 1) {
    const cell = line[index];
    const following = line[index + 1];
    if (cell && following) advances.set(cell.cluster, following.x - cell.x);
  }
  const lineMetrics: LineMetrics = {
    narrowAdvance: nextCell.x - targetCell.x,
    tabSize: DEFAULT_CODE_FONT.tabSize,
    baseline: 0,
    lineHeight: DEFAULT_CODE_FONT.lineHeight,
    advanceFor: (cluster) => advances.get(cluster) ?? nextCell.x - targetCell.x,
  };
  const expectedColumn = new LineLayout(text, lineMetrics).columnAtX(
    targetLineNumber - 1,
    codeTargetX,
  );
  const body = await canvas.getAttribute("data-widget-body-rect");
  if (!body) throw new Error("Widget body rect is missing");
  const bodyRect = JSON.parse(body) as WidgetBodyRect;
  const point = {
    x: bodyRect.x + targetX * scale,
    y: bodyRect.y + DEFAULT_CODE_FONT.lineHeight * 1.5 * scale,
  };
  await canvas.dblclick({ position: point });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await expect(viewLine).toBeVisible();
  await expect(viewLine).toContainText(firstVisibleText);
  const cursor = JSON.parse(
    (await canvas.getAttribute("data-editor-position")) ?? "{}",
  ) as Record<string, number>;
  expect(cursor).toEqual({ lineNumber: 42, column: expectedColumn });
});

test("Double click on another widget", async ({ page }) => {
  const directoryName = await installDirectoryMock(page, [
    { path: "a.ts", text: "const first = 1;\n" },
    { path: "b.ts", text: "const second = 2;\n" },
  ]);
  await page.goto("/");
  await openFolder(page);
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-content-version", "1");
  await expect(canvas).toHaveAttribute("data-highlighted", "true");

  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await page.keyboard.type("x");

  const rects = await readWidgetRects(page);
  const first = rects.find((entry) => entry.filePath === "a.ts");
  const second = rects.find((entry) => entry.filePath === "b.ts");
  if (!first || !second)
    throw new Error(`Widget rects: ${JSON.stringify(rects)}`);
  const scale = 1;
  const secondPoint = {
    x: second.rect.x + Math.min(120, second.rect.width / 2),
    y: second.rect.y + DEFAULT_CODE_FONT.bodyTop * scale + 24,
  };
  await canvas.dblclick({ position: secondPoint });

  await expect
    .poll(() => readMockFile(page, directoryName, "a.ts"), { timeout: 10_000 })
    .toContain("x");
  await expect(canvas).toHaveAttribute("data-content-version", "2");
  await expect
    .poll(() => page.locator(".monaco-editor .view-line").first().textContent())
    .toContain("second");
  await expect(canvas).toHaveAttribute("data-editing", "true");

  const editorBox = await page.getByTestId("editor").boundingBox();
  if (!editorBox) throw new Error("Editor bounding box is missing");
  const expectedBox = {
    x: second.rect.x,
    y: second.rect.y + DEFAULT_CODE_FONT.bodyTop * scale,
    width: second.rect.width,
    height: second.rect.height - DEFAULT_CODE_FONT.bodyTop * scale,
  };
  const boxMessage = `editor=${JSON.stringify(editorBox)} second=${JSON.stringify(second.rect)}`;
  expect(Math.abs(editorBox.x - expectedBox.x), boxMessage).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(editorBox.y - expectedBox.y), boxMessage).toBeLessThanOrEqual(
    1,
  );
  expect(
    Math.abs(editorBox.width - expectedBox.width),
    boxMessage,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(editorBox.height - expectedBox.height),
    boxMessage,
  ).toBeLessThanOrEqual(1);
});

interface TextMetricsResult {
  readonly maxDx: number;
  readonly maxBaselineDelta: number;
  readonly samples: number;
  readonly mismatch?: string;
  readonly toleranceViolation?: {
    readonly line: number;
    readonly glyph: number;
    readonly delta: number;
    readonly n: number;
    readonly tolerance: number;
  };
  readonly worst?: {
    readonly line: number;
    readonly glyph: number;
    readonly cluster: string;
    readonly gpuX: number;
    readonly monacoX: number;
    readonly delta: number;
    readonly n: number;
    readonly tolerance: number;
  };
}

type HorizontalMetricsResult = Pick<
  TextMetricsResult,
  "maxDx" | "samples" | "mismatch" | "toleranceViolation" | "worst"
>;

interface GlyphSequenceLine {
  readonly lineIndex: number;
  readonly gpu: readonly { readonly cluster: string; readonly x: number }[];
  readonly monaco: readonly {
    readonly cluster: string;
    readonly x: number;
    readonly n: number;
    readonly tolerance: number;
  }[];
}

interface BrowserTextNode {
  readonly node: Node;
  readonly text: string;
  readonly start: number;
  readonly n: number;
}

function readGlyphSequencesInBrowser(): readonly GlyphSequenceLine[] {
  const canvas = document.querySelector<HTMLElement>("[data-testid=canvas]");
  const editor = document.querySelector<HTMLElement>("[data-testid=editor]");
  if (!canvas || !editor) throw new Error("Text Metrics surfaces are missing");
  const exposed = window.__codeCanvasTest?.textMetrics();
  if (!exposed) throw new Error("Code Canvas test hook is missing");
  const scale = Number(canvas.getAttribute("data-text-metrics-scale") ?? 1);
  const viewLines = editor.querySelector<HTMLElement>(".view-lines");
  if (!viewLines) throw new Error("Monaco view-lines are missing");
  const viewRect = viewLines.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  const visibleLines = Array.from(
    editor.querySelectorAll<HTMLElement>(".view-line"),
  );
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  return visibleLines.flatMap((line) => {
    const lineRect = line.getBoundingClientRect();
    if (lineRect.bottom <= viewRect.top || lineRect.top >= viewRect.bottom)
      return [];
    const lineIndex = Math.max(
      0,
      Math.round((lineRect.top - viewRect.top) / lineRect.height),
    );
    const gpu = (exposed.lines[lineIndex] ?? []).map((cell) => ({
      cluster: cell.cluster,
      x: cell.x * scale,
    }));
    const textNodes: BrowserTextNode[] = [];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let fullText = "";
    let previousParent: Element | null = null;
    let n = 0;
    while (node) {
      const text = node.textContent ?? "";
      const parent = node.parentElement;
      if (parent !== previousParent) {
        if (previousParent !== null) n += 1;
        previousParent = parent;
      }
      textNodes.push({
        node,
        text,
        start: fullText.length,
        n,
      });
      fullText += text;
      node = walker.nextNode();
    }
    const monaco: GlyphSequenceLine["monaco"][number][] = [];
    for (const { segment, index } of segmenter.segment(fullText)) {
      if (/^\s+$/u.test(segment)) continue;
      const location = textNodes.find(
        (entry) =>
          index >= entry.start && index < entry.start + entry.text.length,
      );
      if (!location) continue;
      const range = document.createRange();
      const rangeOffset = index - location.start;
      range.setStart(location.node, rangeOffset);
      range.setEnd(location.node, rangeOffset);
      monaco.push({
        cluster: segment,
        x: range.getBoundingClientRect().left - editorRect.left,
        n: location.n,
        tolerance: (scale * location.n) / 128 + 0.05,
      });
    }
    return [{ lineIndex, gpu, monaco }];
  });
}

async function readGlyphSequences(
  page: Page,
): Promise<readonly GlyphSequenceLine[]> {
  return page.evaluate(readGlyphSequencesInBrowser);
}

async function readHorizontalTextMetrics(
  page: Page,
): Promise<HorizontalMetricsResult> {
  const lines = await readGlyphSequences(page);
  let maxDx = 0;
  let samples = 0;
  let mismatch: string | undefined;
  let toleranceViolation: TextMetricsResult["toleranceViolation"];
  let worst: TextMetricsResult["worst"];
  lines.forEach(({ lineIndex, gpu, monaco }) => {
    if (gpu.length !== monaco.length && mismatch === undefined) {
      mismatch = `line ${String(lineIndex + 1)} glyph count GPU=${String(gpu.length)} Monaco=${String(monaco.length)}`;
    }
    const count = Math.min(gpu.length, monaco.length);
    for (let index = 0; index < count; index += 1) {
      const gpuGlyph = gpu[index];
      const monacoGlyph = monaco[index];
      if (!gpuGlyph || !monacoGlyph) continue;
      if (gpuGlyph.cluster !== monacoGlyph.cluster) {
        mismatch ??= `line ${String(lineIndex + 1)} glyph ${String(index + 1)} GPU=${JSON.stringify(gpuGlyph.cluster)} Monaco=${JSON.stringify(monacoGlyph.cluster)}`;
        continue;
      }
      const delta = Math.abs(gpuGlyph.x - monacoGlyph.x);
      samples += 1;
      if (delta > monacoGlyph.tolerance) {
        toleranceViolation ??= {
          line: lineIndex + 1,
          glyph: index + 1,
          delta,
          n: monacoGlyph.n,
          tolerance: monacoGlyph.tolerance,
        };
      }
      if (delta > maxDx) {
        maxDx = delta;
        worst = {
          line: lineIndex + 1,
          glyph: index + 1,
          cluster: gpuGlyph.cluster,
          gpuX: gpuGlyph.x,
          monacoX: monacoGlyph.x,
          delta,
          n: monacoGlyph.n,
          tolerance: monacoGlyph.tolerance,
        };
      }
    }
  });
  return {
    maxDx,
    samples,
    ...(mismatch ? { mismatch } : {}),
    ...(toleranceViolation ? { toleranceViolation } : {}),
    ...(worst ? { worst } : {}),
  };
}

async function readBaselineDelta(page: Page): Promise<number> {
  const maxBaselineDelta = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>("[data-testid=canvas]");
    const editor = document.querySelector<HTMLElement>("[data-testid=editor]");
    if (!canvas || !editor)
      throw new Error("Text Metrics surfaces are missing");
    const exposed = window.__codeCanvasTest?.textMetrics();
    if (!exposed) throw new Error("Code Canvas test hook is missing");
    const scale = Number(canvas.getAttribute("data-text-metrics-scale") ?? 1);
    const viewLines = editor.querySelector<HTMLElement>(".view-lines");
    if (!viewLines) return 0;
    const baselineExpected = exposed.baseline;
    const viewRect = viewLines.getBoundingClientRect();
    return Math.max(
      ...Array.from(editor.querySelectorAll<HTMLElement>(".view-line"))
        .filter((line) => {
          const rect = line.getBoundingClientRect();
          return rect.bottom > viewRect.top && rect.top < viewRect.bottom;
        })
        .map((line) => {
          const firstSpan = line.querySelector("span");
          if (!firstSpan) return 0;
          const marker = document.createElement("span");
          marker.style.display = "inline-block";
          marker.style.width = "0px";
          marker.style.height = "0px";
          marker.style.verticalAlign = "baseline";
          firstSpan.append(marker);
          const baseline =
            marker.getBoundingClientRect().top -
            line.getBoundingClientRect().top;
          marker.remove();
          return Math.abs(baselineExpected * scale - baseline);
        }),
      0,
    );
  });
  return maxBaselineDelta;
}

async function readTextMetricsConformance(
  page: Page,
): Promise<TextMetricsResult> {
  const horizontal = await readHorizontalTextMetrics(page);
  return { ...horizontal, maxBaselineDelta: await readBaselineDelta(page) };
}

async function enterAndCheckMetrics(
  page: Page,
  label: string,
  hasVisibleGlyphs: boolean,
): Promise<void> {
  const canvas = page.getByTestId("canvas");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await expect(page.locator(".monaco-editor .view-line").first()).toBeVisible();
  await expect(canvas).toHaveAttribute("data-highlighted", "true");
  const result = await readTextMetricsConformance(page);
  const cameraScale = Number(
    await canvas.getAttribute("data-text-metrics-scale"),
  );
  console.info(
    `Text Metrics conformance ${label} camera scale=${String(cameraScale)}: max |dx|=${String(result.maxDx)} baseline Δ=${String(result.maxBaselineDelta)} samples=${String(result.samples)}${result.mismatch ? ` mismatch=${result.mismatch}` : ""}${result.worst ? ` worst=${JSON.stringify(result.worst)}` : ""}`,
  );
  expect(result.mismatch, `${label}: glyph sequence`).toBeUndefined();
  expect(
    result.toleranceViolation,
    `${label}: per-glyph tolerance`,
  ).toBeUndefined();
  if (hasVisibleGlyphs) {
    expect(
      result.samples,
      `${label}: no visible glyph samples`,
    ).toBeGreaterThan(0);
  } else {
    expect(result.samples, `${label}: unexpected glyph samples`).toBe(0);
  }
  expect(result.maxBaselineDelta, `${label}: baseline`).toBeLessThanOrEqual(
    0.5,
  );
}

async function cameraScale(page: Page): Promise<number> {
  return Number(
    await page.getByTestId("canvas").getAttribute("data-text-metrics-scale"),
  );
}

async function zoomCanvasTo(page: Page, target: number): Promise<void> {
  // One event's zoom step is clamped to exp(±MAX_ZOOM_STEP_LN) (design D8
  // "Pinch follows the fingers"), so reaching a distant target takes several
  // ctrl+wheel events, each covering at most MAX_ZOOM_STEP_LN of ln(scale).
  const current = await cameraScale(page);
  let remainingLn = Math.log(target / current);
  const canvas = page.getByTestId("canvas");
  while (Math.abs(remainingLn) > 1e-9) {
    const step =
      Math.sign(remainingLn) *
      Math.min(Math.abs(remainingLn), MAX_ZOOM_STEP_LN);
    await canvas.dispatchEvent("wheel", {
      deltaY: -step * PINCH_WHEEL_DELTA_PER_LN_SCALE,
      ctrlKey: true,
    });
    remainingLn -= step;
  }
  await expect.poll(() => cameraScale(page)).toBeCloseTo(target, 2);
}

async function checkAtScales(
  page: Page,
  text: string,
  label: string,
): Promise<void> {
  const hasVisibleGlyphs = Array.from(text).some(
    (character) => !/\s/u.test(character),
  );
  await openFile(page, text);
  for (const [index, target] of [1, 0.8, 1.37, 2].entries()) {
    if (index > 0) {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("canvas")).toHaveAttribute(
        "data-editing",
        "false",
      );
      await zoomCanvasTo(page, target);
    }
    await enterAndCheckMetrics(
      page,
      `${label} zoom=${String(target)}`,
      hasVisibleGlyphs,
    );
  }
}

test("Text Metrics conformance", async ({ page }) => {
  const corpus = generateEdgeCaseCorpus();
  for (const file of corpus.files) {
    await checkAtScales(page, file.text, file.relativePath);
  }
  const reference = await readFile(
    "fixtures/reference-dataset/group-00/widget-000.tsx",
    "utf8",
  );
  await checkAtScales(page, reference, "group-00/widget-000.tsx");
});

test("Escape", async ({ page }) => {
  await openFile(page, "const answer = 42;\n");
  await page
    .getByTestId("canvas")
    .dblclick({ position: await bodyPoint(page) });
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-editing",
    "true",
  );
  await page.keyboard.type(" ");
  const startTick = await lastFrameTick(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-editing",
    "false",
  );
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-content-version",
    "2",
  );
  await assertHeldExitFrames(page, startTick, 2);

  await openFile(page, "const answer = 42;\n".repeat(100));
  const canvas = page.getByTestId("canvas");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await page.keyboard.press("PageDown");
  const scrollStartTick = await lastFrameTick(page);
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-editing", "false");
  await expect(canvas).toHaveAttribute("data-content-version", "1");
  await assertHeldExitFrames(page, scrollStartTick, 1);
});

test("Opening without a change", async ({ page }) => {
  await openFile(page, "const answer = 42;\rconst other = 7;\r");
  const canvas = page.getByTestId("canvas");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-editing", "false");
  await expect(canvas).toHaveAttribute("data-content-version", "1");
});

test("Pan during editing", async ({ page }) => {
  await openFile(page, "const answer = 42;\n");
  const point = await bodyPoint(page);
  await page.getByTestId("canvas").dblclick({ position: point });
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-editing",
    "true",
  );
  await page.keyboard.type("x");
  const startTick = await lastFrameTick(page);
  const before = await page
    .getByTestId("canvas")
    .getAttribute("data-widget-body-rect");
  const value = JSON.parse(before ?? "{}") as WidgetBodyRect;
  await page.mouse.move(value.x - 10, value.y + 20);
  await page.mouse.down();
  await page.mouse.move(value.x + 90, value.y - 20);
  await page.mouse.up();
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-editing",
    "false",
  );
  await expect
    .poll(async () =>
      page.getByTestId("canvas").getAttribute("data-widget-body-rect"),
    )
    .not.toBe(before);
  await assertHeldExitFrames(page, startTick, 2);
});

test.describe("Highlighting after an edit", () => {
  test("one-line file", async ({ page }) => {
    await assertHighlightingAfterEdit(
      page,
      "const answer = 42;\n",
      "one-line file",
    );
  });

  test("2000-line file", async ({ page }) => {
    const text = await readFile(
      "fixtures/reference-dataset/group-00/widget-000.tsx",
      "utf8",
    );
    await assertHighlightingAfterEdit(page, text, "2000-line file");
  });
});

test("Zoom during editing", async ({ page }) => {
  const text = "const answer = 42;\n";
  const targetScale = 1.37;
  await openFile(page, text);
  await pinchWithCdp(page, targetScale);
  await page.waitForTimeout(200);
  const referenceScale = await cameraScale(page);

  await openFile(page, text);
  const canvas = page.getByTestId("canvas");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await page.keyboard.type("x");
  const startTick = await lastFrameTick(page);
  await pinchWithCdp(page, targetScale);
  await expect(canvas).toHaveAttribute("data-editing", "false");
  await expect(canvas).toHaveAttribute("data-content-version", "2");
  await page.waitForTimeout(200);
  expect(
    Math.abs((await cameraScale(page)) - referenceScale),
  ).toBeLessThanOrEqual(0.005);
  await assertHeldExitFrames(page, startTick, 2);
});

test("Escape without edits hides the editor in the first tick", async ({
  page,
}) => {
  await openFile(page, "const answer = 42;\n");
  const canvas = page.getByTestId("canvas");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  const beforeEscape = await lastFrameTick(page);
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-editing", "false");
  await expect
    .poll(async () => {
      const entries = await readFrameLog(page);
      return entries.filter((entry) => entry.tick > beforeEscape).length;
    })
    .toBeGreaterThan(0);
  const firstAfterEscape = (await readFrameLog(page)).find(
    (entry: FrameLogEntry) => entry.tick > beforeEscape,
  );
  expect(firstAfterEscape?.editorVisible).toBe(false);
});

test("Edge-case Corpus line-count parity", async ({ page }) => {
  const corpus = generateEdgeCaseCorpus();
  for (const file of corpus.files) {
    await openFile(page, file.text);
    await page
      .getByTestId("canvas")
      .dblclick({ position: await bodyPoint(page) });
    await expect(page.getByTestId("canvas")).toHaveAttribute(
      "data-editor-line-count",
      String(splitSourceLines(file.text).length),
    );
  }
});
