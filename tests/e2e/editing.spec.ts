import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import {
  generateEdgeCaseCorpus,
  splitSourceLines,
} from "../../fixtures/lib/dataset";
import {
  LineLayout,
  type LineMetrics,
} from "../../src/code-view/domain/line-layout";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";

test.describe.configure({ mode: "serial" });
test.use({ deviceScaleFactor: 2 });

async function installDirectoryMock(page: Page, text: string): Promise<void> {
  await page.addInitScript((initialText: string) => {
    window.name = initialText;
    const file = {
      kind: "file",
      name: "widget-000.tsx",
      getFile: () => Promise.resolve(new File([window.name], "widget-000.tsx")),
    };
    const directory = {
      kind: "directory",
      name: "workspace",
      entries: async function* () {
        await Promise.resolve();
        yield ["widget-000.tsx", file];
      },
    };
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: () => Promise.resolve(directory),
    });
  }, text);
}

interface WidgetBodyRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function openFile(page: Page, text: string): Promise<void> {
  await installDirectoryMock(page, text);
  await page.goto("/");
  await page.getByTestId("open-folder").click();
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-content-version",
    "1",
  );
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-highlighted",
    "true",
  );
}

async function bodyPoint(page: Page): Promise<{ x: number; y: number }> {
  const value = await page
    .getByTestId("canvas")
    .getAttribute("data-widget-body-rect");
  if (!value) throw new Error("Widget body rect is missing");
  const rect = JSON.parse(value) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  return { x: rect.x + Math.min(120, rect.width / 2), y: rect.y + 24 };
}

test("Double click on a line", async ({ page }) => {
  const text = "abcdefghij\nklmnopqrst\n";
  await openFile(page, text);
  await zoomCanvasTo(page, 1.37);
  const canvas = page.getByTestId("canvas");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await expect(page.locator(".monaco-editor .view-line").first()).toBeVisible();
  const metrics = await page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    return hook.textMetrics();
  });
  const scale = Number(await canvas.getAttribute("data-text-metrics-scale"));
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-editing", "false");
  const line = metrics.lines[0] ?? [];
  const targetIndex = 4;
  const targetCell = line[targetIndex];
  const nextCell = line[targetIndex + 1];
  if (!targetCell || !nextCell) throw new Error("Cursor probe cell is missing");
  const targetX = targetCell.x + (nextCell.x - targetCell.x) / 4;
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
    advanceFor: (cluster) => advances.get(cluster) ?? nextCell.x - targetCell.x,
  };
  const expectedColumn = new LineLayout(text, lineMetrics).columnAtX(
    0,
    targetX,
  );
  const body = await page
    .getByTestId("canvas")
    .getAttribute("data-widget-body-rect");
  if (!body) throw new Error("Widget body rect is missing");
  const bodyRect = JSON.parse(body) as WidgetBodyRect;
  const point = {
    x: bodyRect.x + targetX * scale,
    y: bodyRect.y + (DEFAULT_CODE_FONT.lineHeight * scale) / 2,
  };
  await canvas.dblclick({ position: point });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await expect(page.locator(".monaco-editor .view-line").first()).toBeVisible();
  const cursor = JSON.parse(
    (await canvas.getAttribute("data-editor-position")) ?? "{}",
  ) as { readonly lineNumber?: number; readonly column?: number };
  expect(cursor).toEqual({ lineNumber: 1, column: expectedColumn });
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
        x: range.getBoundingClientRect().left - viewRect.left,
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
  const current = await cameraScale(page);
  const deltaY = -Math.log(target / current) / 0.002;
  await page.getByTestId("canvas").dispatchEvent("wheel", {
    deltaY,
    ctrlKey: true,
  });
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
  const exitedAt = await page.evaluate(() => performance.now());
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-editing",
    "false",
  );
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-content-version",
    "2",
  );
  await expect
    .poll(
      async () => page.getByTestId("canvas").getAttribute("data-highlighted"),
      {
        timeout: 100,
      },
    )
    .toBe("true");
  const highlightedAt = await page.evaluate(() => performance.now());
  expect(highlightedAt - exitedAt).toBeLessThanOrEqual(100);
});

test("Pan during editing", async ({ page }) => {
  await openFile(page, "const answer = 42;\n");
  const point = await bodyPoint(page);
  await page.getByTestId("canvas").dblclick({ position: point });
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-editing",
    "true",
  );
  const before = await page
    .getByTestId("canvas")
    .getAttribute("data-widget-body-rect");
  const value = JSON.parse(before ?? "{}") as WidgetBodyRect;
  await page.mouse.move(value.x + 10, value.y - 20);
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
});

test("Highlighting after an edit", async ({ page }) => {
  await openFile(page, "const answer = 42;\n");
  await page
    .getByTestId("canvas")
    .dblclick({ position: await bodyPoint(page) });
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-editing",
    "false",
  );
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-highlighted",
    "true",
    {
      timeout: 100,
    },
  );
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
