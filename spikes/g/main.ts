const RASTER_SIZES = [8, 12, 16, 24, 32, 48, 64, 96] as const;
const BASE_FONT_SIZE = 14;
const BASE_LINE_HEIGHT = 20;
const TEXT_REGION_WIDTH = 1200;
const MAX_REGION_COLUMNS = Math.floor(
  TEXT_REGION_WIDTH / (BASE_FONT_SIZE * 0.6),
);
const TEXT_REGION_TOP = 26;
const SDF_GRID_WIDTH = 40;
const SDF_GRID_HEIGHT = 64;
const SDF_FONT_SIZE = 48;
const DEBOUNCE_MS = 160;
const FALLBACK_TEXT = `const glyphRecord: Record<string, number> = { punctuation: 42, id: 7 }; // Привет 東京 🧭
const view = <article data-id={42} aria-label="text sharpness"><span>{unicodeText}</span></article>;
/* multiline comment: colors and spacing must remain readable */
const template = \`value=\${fixtureId}: Привет 東京 🧭\`;`;
const REFERENCE_PATH = "fixtures/reference-dataset/group-00/widget-000.tsx";
const rawReferenceFiles = import.meta.glob<string>(
  "/fixtures/reference-dataset/group-00/widget-000.tsx",
  { eager: true, import: "default", query: "?raw" },
);

type SwitchMode = "mid-gesture" | "debounced";

interface Atlas {
  rasterSize: number;
  canvas: HTMLCanvasElement;
  buildMs: number;
  rasterMs: number;
  uploadMs: number;
  usedGlyphCount: number;
}

interface SdfGlyph {
  values: Uint8Array;
}

interface SwitchRecord {
  mode: SwitchMode;
  from: number;
  to: number;
  buildMs: number;
  rasterMs: number;
  uploadMs: number;
  usedGlyphCount: number;
  frame: number;
  timestamp: number;
}

interface Metrics {
  mode: SwitchMode;
  frameIntervalsMs: number[];
  frameDurationsMs: number[];
  switches: SwitchRecord[];
}

interface MeasurementSummary {
  mode: SwitchMode;
  frames: number;
  worstFrameMs: number;
  p99FrameMs: number;
  worstIntervalMs: number;
  intervalsOver12_5ms: number;
  switches: SwitchRecord[];
}

interface RenderedLineBand {
  top: number;
  bottom: number;
}

interface SpikeApi {
  getState: () => Record<string, unknown>;
  getRenderedLineBands: () => RenderedLineBand[];
  setMode: (mode: SwitchMode) => void;
  setZoom: (zoom: number, gestureActive?: boolean) => void;
  clearMetrics: () => void;
  runZoomSequence: (mode: SwitchMode) => Promise<MeasurementSummary>;
  getMetrics: () => MeasurementSummary;
}

declare global {
  interface Window {
    __spikeG?: SpikeApi;
  }
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Spike G is missing ${label}`);
  return value;
}

const discreteCanvas = required(
  document.querySelector<HTMLCanvasElement>("#discrete-canvas"),
  "the discrete canvas",
);
const sdfCanvas = required(
  document.querySelector<HTMLCanvasElement>("#sdf-canvas"),
  "the SDF canvas",
);
const zoomInput = required(
  document.querySelector<HTMLInputElement>("#zoom"),
  "the zoom input",
);
const modeSelect = required(
  document.querySelector<HTMLSelectElement>("#switch-mode"),
  "the switch mode",
);
const readyState = required(
  document.querySelector<HTMLElement>("#ready-state"),
  "the ready state",
);
const resultLog = required(
  document.querySelector<HTMLElement>("#results-log"),
  "the results log",
);
const atlasCaption = required(
  document.querySelector<HTMLElement>("#atlas-caption"),
  "the atlas caption",
);
const copyButton = required(
  document.querySelector<HTMLButtonElement>("#copy-results"),
  "the copy button",
);
const discreteContext = required(
  discreteCanvas.getContext("2d"),
  "the discrete canvas context",
);
const sdfContext = required(
  sdfCanvas.getContext("2d"),
  "the SDF canvas context",
);

let sourceText = FALLBACK_TEXT;
let sourcePath = "fallback sample — generate fixtures/reference-dataset first";
let lines = FALLBACK_TEXT.split("\n");
let zoom = 1;
let mode: SwitchMode = "mid-gesture";
let activeRasterSize = 16;
let pendingRasterSize: number | undefined;
let debounceTimer: number | undefined;
let lastFrameTime: number | undefined;
let currentFrame = 0;
let collectDirectRenders = false;
let metrics: Metrics = {
  mode,
  frameIntervalsMs: [],
  frameDurationsMs: [],
  switches: [],
};
const atlasCache = new Map<number, Atlas>();
const sdfCache = new Map<string, SdfGlyph>();
let activeAtlas: Atlas | undefined;
let sdfLayer: HTMLCanvasElement | undefined;

function setStatus(message: string): void {
  resultLog.textContent = message;
}

function getDpr(): number {
  return window.devicePixelRatio || 1;
}

function getTextRegionLines(): string[] {
  return lines.map((line) =>
    Array.from(line).slice(0, MAX_REGION_COLUMNS).join(""),
  );
}

function prepareCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = getDpr();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.textBaseline = "alphabetic";
}

function pickRasterSize(targetFontSize: number): number {
  return (
    RASTER_SIZES.find((size) => size >= targetFontSize) ??
    RASTER_SIZES[RASTER_SIZES.length - 1] ??
    96
  );
}

function rasterizeText(rasterSize: number): Atlas {
  const start = performance.now();
  const dpr = getDpr();
  const rasterCanvas = document.createElement("canvas");
  rasterCanvas.width = Math.ceil(TEXT_REGION_WIDTH * dpr);
  rasterCanvas.height = Math.ceil(
    (TEXT_REGION_TOP + lines.length * BASE_LINE_HEIGHT + 24) * dpr,
  );
  const context = rasterCanvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create an atlas canvas");
  }
  context.scale(dpr, dpr);
  context.fillStyle = "#d9e1ee";
  context.font = `${String(rasterSize)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textBaseline = "top";
  const lineHeight = rasterSize * (BASE_LINE_HEIGHT / BASE_FONT_SIZE);
  const regionLines = getTextRegionLines();
  regionLines.forEach((line, index) => {
    context.fillText(line, 20, TEXT_REGION_TOP + index * lineHeight);
  });
  const rasterMs = performance.now() - start;
  const uploadStart = performance.now();
  const uploadedCanvas = document.createElement("canvas");
  uploadedCanvas.width = rasterCanvas.width;
  uploadedCanvas.height = rasterCanvas.height;
  const uploadContext = uploadedCanvas.getContext("2d");
  if (!uploadContext) {
    throw new Error("Could not create an uploaded atlas canvas");
  }
  uploadContext.drawImage(rasterCanvas, 0, 0);
  const uploadMs = performance.now() - uploadStart;
  const usedGlyphCount = new Set(Array.from(regionLines.join(""))).size;
  return {
    rasterSize,
    canvas: uploadedCanvas,
    buildMs: performance.now() - start,
    rasterMs,
    uploadMs,
    usedGlyphCount,
  };
}

function getAtlas(rasterSize: number): Atlas {
  const cached = atlasCache.get(rasterSize);
  if (cached) {
    return cached;
  }
  const atlas = rasterizeText(rasterSize);
  atlasCache.set(rasterSize, atlas);
  return atlas;
}

function applyRasterSize(nextSize: number, nextMode: SwitchMode): void {
  if (nextSize === activeRasterSize) {
    return;
  }
  const previous = activeRasterSize;
  const atlas = getAtlas(nextSize);
  activeRasterSize = nextSize;
  activeAtlas = atlas;
  metrics.switches.push({
    mode: nextMode,
    from: previous,
    to: nextSize,
    buildMs: atlas.buildMs,
    rasterMs: atlas.rasterMs,
    uploadMs: atlas.uploadMs,
    usedGlyphCount: atlas.usedGlyphCount,
    frame: currentFrame + 1,
    timestamp: performance.now(),
  });
}

function updateRasterSize(gestureActive: boolean): void {
  const target = pickRasterSize(BASE_FONT_SIZE * zoom);
  if (mode === "mid-gesture" || !gestureActive) {
    pendingRasterSize = undefined;
    applyRasterSize(target, mode);
    return;
  }
  pendingRasterSize = target;
}

function endGesture(): void {
  if (debounceTimer !== undefined) {
    window.clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(() => {
    if (pendingRasterSize !== undefined) {
      applyRasterSize(pendingRasterSize, "debounced");
      pendingRasterSize = undefined;
      renderAndRecord();
    }
  }, DEBOUNCE_MS);
}

function drawDiscrete(): void {
  prepareCanvas(discreteCanvas, discreteContext);
  const width = discreteCanvas.clientWidth;
  const height = discreteCanvas.clientHeight;
  discreteContext.clearRect(0, 0, width, height);
  discreteContext.fillStyle = "#181e28";
  discreteContext.fillRect(0, 0, width, height);
  const atlas = activeAtlas;
  if (!atlas) {
    throw new Error("The active raster atlas was not prepared before draw");
  }
  const targetFontSize = BASE_FONT_SIZE * zoom;
  const scale = targetFontSize / atlas.rasterSize;
  discreteContext.imageSmoothingEnabled = true;
  discreteContext.drawImage(
    atlas.canvas,
    0,
    0,
    atlas.canvas.width / getDpr(),
    atlas.canvas.height / getDpr(),
    0,
    0,
    TEXT_REGION_WIDTH * scale,
    (atlas.canvas.height / getDpr()) * scale,
  );
}

function distanceTransform(mask: Uint8Array, target: number): Float32Array {
  const distances = new Float32Array(mask.length);
  distances.fill(1000);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === target) {
      distances[index] = 0;
    }
  }
  for (let y = 0; y < SDF_GRID_HEIGHT; y += 1) {
    for (let x = 0; x < SDF_GRID_WIDTH; x += 1) {
      const index = y * SDF_GRID_WIDTH + x;
      let best = distances[index] ?? 1000;
      if (x > 0) best = Math.min(best, (distances[index - 1] ?? 1000) + 1);
      if (y > 0)
        best = Math.min(best, (distances[index - SDF_GRID_WIDTH] ?? 1000) + 1);
      distances[index] = best;
    }
  }
  for (let y = SDF_GRID_HEIGHT - 1; y >= 0; y -= 1) {
    for (let x = SDF_GRID_WIDTH - 1; x >= 0; x -= 1) {
      const index = y * SDF_GRID_WIDTH + x;
      let best = distances[index] ?? 1000;
      if (x + 1 < SDF_GRID_WIDTH)
        best = Math.min(best, (distances[index + 1] ?? 1000) + 1);
      if (y + 1 < SDF_GRID_HEIGHT)
        best = Math.min(best, (distances[index + SDF_GRID_WIDTH] ?? 1000) + 1);
      distances[index] = best;
    }
  }
  return distances;
}

function buildSdfGlyph(character: string): SdfGlyph {
  const cached = sdfCache.get(character);
  if (cached) {
    return cached;
  }
  const canvas = document.createElement("canvas");
  canvas.width = SDF_GRID_WIDTH;
  canvas.height = SDF_GRID_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create an SDF mask canvas");
  }
  context.fillStyle = "black";
  context.fillRect(0, 0, SDF_GRID_WIDTH, SDF_GRID_HEIGHT);
  context.fillStyle = "white";
  context.font = `${String(SDF_FONT_SIZE)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textBaseline = "top";
  context.fillText(character, 0, 3);
  const pixels = context.getImageData(
    0,
    0,
    SDF_GRID_WIDTH,
    SDF_GRID_HEIGHT,
  ).data;
  const mask = new Uint8Array(SDF_GRID_WIDTH * SDF_GRID_HEIGHT);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = (pixels[index * 4] ?? 0) > 128 ? 1 : 0;
  }
  const inside = distanceTransform(mask, 0);
  const outside = distanceTransform(mask, 1);
  const values = new Uint8Array(mask.length);
  for (let index = 0; index < values.length; index += 1) {
    const signedDistance =
      mask[index] === 1 ? (inside[index] ?? 0) : -(outside[index] ?? 0);
    values[index] = Math.max(
      0,
      Math.min(255, Math.round(128 + signedDistance * 16)),
    );
  }
  const glyph = { values };
  sdfCache.set(character, glyph);
  return glyph;
}

function buildSdfLayer(
  outputWidth: number,
  outputHeight: number,
  dpr: number,
): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  layer.width = outputWidth;
  layer.height = outputHeight;
  const pixels = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  const scale = BASE_FONT_SIZE / SDF_FONT_SIZE;
  const cellWidth = BASE_FONT_SIZE * 0.6;
  const lineHeight = BASE_LINE_HEIGHT;
  const top = TEXT_REGION_TOP;
  const regionLines = getTextRegionLines();
  regionLines.forEach((line, lineIndex) => {
    Array.from(line).forEach((character, column) => {
      const glyph = buildSdfGlyph(character);
      const left = (20 + column * cellWidth) * dpr;
      const topPx = (top + lineIndex * lineHeight) * dpr;
      const glyphWidth = Math.max(1, Math.ceil(SDF_GRID_WIDTH * scale * dpr));
      const glyphHeight = Math.max(1, Math.ceil(SDF_GRID_HEIGHT * scale * dpr));
      for (let y = 0; y < glyphHeight; y += 1) {
        const outputY = Math.floor(topPx + y);
        if (outputY < 0 || outputY >= outputHeight) continue;
        const sourceY = Math.min(
          SDF_GRID_HEIGHT - 1,
          Math.floor(y / (scale * dpr)),
        );
        for (let x = 0; x < glyphWidth; x += 1) {
          const outputX = Math.floor(left + x);
          if (outputX < 0 || outputX >= outputWidth) continue;
          const sourceX = Math.min(
            SDF_GRID_WIDTH - 1,
            Math.floor(x / (scale * dpr)),
          );
          const source = glyph.values[sourceY * SDF_GRID_WIDTH + sourceX] ?? 0;
          const distance = ((source - 128) / 16) * scale * dpr;
          const alpha = Math.max(
            0,
            Math.min(255, Math.round(128 + distance * 255)),
          );
          const index = (outputY * outputWidth + outputX) * 4;
          pixels[index] = 217;
          pixels[index + 1] = 225;
          pixels[index + 2] = 238;
          pixels[index + 3] = Math.max(pixels[index + 3] ?? 0, alpha);
        }
      }
    });
  });
  layer
    .getContext("2d")
    ?.putImageData(new ImageData(pixels, outputWidth, outputHeight), 0, 0);
  return layer;
}

function getPreparedSdfLayer(): HTMLCanvasElement {
  const layer = sdfLayer;
  if (layer?.width !== sdfCanvas.width || layer.height !== sdfCanvas.height) {
    const preparedLayer = buildSdfLayer(
      sdfCanvas.width,
      sdfCanvas.height,
      getDpr(),
    );
    sdfLayer = preparedLayer;
    return preparedLayer;
  }
  return layer;
}

function drawSdf(): void {
  prepareCanvas(sdfCanvas, sdfContext);
  const width = sdfCanvas.clientWidth;
  const height = sdfCanvas.clientHeight;
  sdfContext.clearRect(0, 0, width, height);
  sdfContext.fillStyle = "#181e28";
  sdfContext.fillRect(0, 0, width, height);
  const preparedLayer = getPreparedSdfLayer();
  const zoomScale = zoom;
  sdfContext.drawImage(
    preparedLayer,
    0,
    0,
    (preparedLayer.width / getDpr()) * zoomScale,
    (preparedLayer.height / getDpr()) * zoomScale,
  );
}

function render(): number {
  const start = performance.now();
  activeAtlas ??= getAtlas(activeRasterSize);
  drawDiscrete();
  drawSdf();
  atlasCaption.textContent = `Discrete-size atlas — target ${(BASE_FONT_SIZE * zoom).toFixed(2)}px, active raster ${activeRasterSize.toFixed(0)}px`;
  return performance.now() - start;
}

function renderAndRecord(): void {
  const duration = render();
  if (collectDirectRenders) {
    metrics.frameDurationsMs.push(duration);
  }
}

function frame(timestamp: number): void {
  currentFrame += 1;
  if (lastFrameTime !== undefined) {
    metrics.frameIntervalsMs.push(timestamp - lastFrameTime);
  }
  metrics.frameDurationsMs.push(render());
  lastFrameTime = timestamp;
  window.requestAnimationFrame(frame);
}

function sortedPercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * percentile) - 1,
  );
  return sorted[index] ?? 0;
}

function summarizeMetrics(): MeasurementSummary {
  return {
    mode: metrics.mode,
    frames: metrics.frameDurationsMs.length,
    worstFrameMs: Math.max(0, ...metrics.frameDurationsMs),
    p99FrameMs: sortedPercentile(metrics.frameDurationsMs, 0.99),
    worstIntervalMs: Math.max(0, ...metrics.frameIntervalsMs),
    intervalsOver12_5ms: metrics.frameIntervalsMs.filter(
      (interval) => interval > 12.5,
    ).length,
    switches: [...metrics.switches],
  };
}

function clearMetrics(): void {
  metrics = { mode, frameIntervalsMs: [], frameDurationsMs: [], switches: [] };
  lastFrameTime = undefined;
  currentFrame = 0;
}

function setMode(nextMode: SwitchMode): void {
  mode = nextMode;
  metrics.mode = nextMode;
  modeSelect.value = nextMode;
}

function setZoom(nextZoom: number, gestureActive = false): void {
  zoom = Math.max(0.4, Math.min(4, nextZoom));
  zoomInput.value = zoom.toFixed(2);
  updateRasterSize(gestureActive);
  renderAndRecord();
}

async function runZoomSequence(
  nextMode: SwitchMode,
): Promise<MeasurementSummary> {
  setMode(nextMode);
  clearMetrics();
  collectDirectRenders = true;
  atlasCache.clear();
  activeAtlas = undefined;
  activeRasterSize = pickRasterSize(8);
  setZoom(0.5, true);
  const path = Array.from(
    { length: 80 },
    (_, index) => 0.5 + index * (2.8 / 79),
  );
  for (const value of path) {
    setZoom(value, true);
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });
  }
  endGesture();
  await new Promise<void>((resolve) =>
    window.setTimeout(resolve, DEBOUNCE_MS + 80),
  );
  collectDirectRenders = false;
  return summarizeMetrics();
}

function getState(): Record<string, unknown> {
  return {
    ready: readyState.textContent.startsWith("ready"),
    datasetAvailable: sourcePath.startsWith("fixtures/reference-dataset/"),
    sourcePath,
    sourceTextLength: sourceText.length,
    sourceTextPrefix: sourceText.slice(0, 240),
    devicePixelRatio: getDpr(),
    rasterSizes: [...RASTER_SIZES],
    activeRasterSize,
    zoom,
  };
}

function getRenderedLineBands(): RenderedLineBand[] {
  return lines.map((_, index) => ({
    top: Math.max(0, (TEXT_REGION_TOP + index * BASE_LINE_HEIGHT) * zoom - 2),
    bottom: Math.min(
      sdfCanvas.clientHeight,
      (TEXT_REGION_TOP + (index + 1) * BASE_LINE_HEIGHT) * zoom + 2,
    ),
  }));
}

function loadReferenceText(): void {
  const rawText = rawReferenceFiles[`/${REFERENCE_PATH}`];
  if (rawText === undefined) {
    sourceText = FALLBACK_TEXT;
  } else {
    sourceText = rawText;
    sourcePath = REFERENCE_PATH;
  }
  lines = sourceText.split("\n").slice(0, 18);
  activeAtlas = undefined;
  sdfLayer = undefined;
  readyState.textContent = `ready — ${sourcePath}`;
  render();
}

function copyResults(): void {
  const result = JSON.stringify(
    { state: getState(), metrics: summarizeMetrics() },
    null,
    2,
  );
  void navigator.clipboard.writeText(result).then(() => {
    setStatus("Copied current results JSON.");
  });
}

zoomInput.addEventListener("change", () => {
  setZoom(Number(zoomInput.value));
});
modeSelect.addEventListener("change", () => {
  setMode(modeSelect.value as SwitchMode);
});
copyButton.addEventListener("click", copyResults);
window.addEventListener("resize", render);

window.__spikeG = {
  getState,
  getRenderedLineBands,
  setMode,
  setZoom,
  clearMetrics,
  runZoomSequence,
  getMetrics: summarizeMetrics,
};
window.requestAnimationFrame(frame);
loadReferenceText();
