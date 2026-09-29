import { TokenMetadata } from "monaco-editor/editor/common/encodedTokenAttributes.js";
import { TokenTheme } from "monaco-editor/editor/common/languages/supports/tokenization.js";
import { vs_dark } from "monaco-editor/editor/standalone/common/themes.js";
import {
  measureWidgetCoverage,
  summarizeWidgetCoverage,
  type CoverageRect,
  type CoverageWidget,
  type WidgetCoverageSummary,
} from "./coverage";
import type { WorkerMessage, WorkerRequest, WorkerResponse } from "./protocol";

const DATASET_COUNT = 200;
const MINIMAP_WIDTH = 256;
const MINIMAP_HEIGHT = 512;
const TEXT_TO_MINIMAP_PX = 9;
const MINIMAP_TO_TEXT_PX = 11;
const LINE_HEIGHT = 21;
const FONT_SIZE = 14;
const FONT_FAMILY = "Menlo, monospace";
const WIDGET_WIDTH = 600;
const WIDGET_HEIGHT = 400;
const HEADER_HEIGHT = 32;
const BODY_HEIGHT = WIDGET_HEIGHT - HEADER_HEIGHT;
const GRID_COLUMNS = 10;
const GRID_GAP = 40;
const CAMERA_X = (GRID_COLUMNS * (WIDGET_WIDTH + GRID_GAP) - GRID_GAP) / 2;
const CAMERA_Y = (20 * (WIDGET_HEIGHT + GRID_GAP) - GRID_GAP) / 2;
// Glyph atlas: same proven layout as spike B (R8, 2x raster, Canvas2D fillText).
const GLYPH_RASTER_SCALE = 2;
const GLYPH_ATLAS_COLUMNS = 16;
const GLYPH_ATLAS_ROWS = 16;
const GLYPH_ATLAS_CELL_SIZE = 32 * GLYPH_RASTER_SCALE;
const GLYPH_ATLAS_WIDTH = GLYPH_ATLAS_COLUMNS * GLYPH_ATLAS_CELL_SIZE;
const GLYPH_ATLAS_HEIGHT = GLYPH_ATLAS_ROWS * GLYPH_ATLAS_CELL_SIZE;
const MAX_GLYPH_SLOTS = GLYPH_ATLAS_COLUMNS * GLYPH_ATLAS_ROWS;
const GLYPH_FALLBACK = "□";
const MINIMAP_PALETTE_SLOTS = 32;
const INSTANCE_STRIDE = 14;
const theme = TokenTheme.createFromRawTokenTheme(vs_dark.rules, []);
const scopeColors = createScopeColors();
const scopePalette = createScopePalette(scopeColors);
const scopeRgb = createScopeRgb();

interface DatasetFile {
  readonly fileId: string;
  readonly text: string;
  readonly lines: readonly string[];
  readonly hash: string;
}

interface DatasetCheck {
  readonly fileId: string;
  readonly length: number;
  readonly prefix: string;
  readonly hash: string;
}

interface PreparedFile {
  readonly file: DatasetFile;
  readonly colors: Uint32Array;
  readonly lineOffsets: Uint32Array;
  readonly minimap: Uint8Array;
  readonly minimapHeight: number;
}

interface WidgetGeometry {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly glyphStart: number;
  readonly glyphEnd: number;
  readonly expectedVisibleLines: number;
  readonly glyphInstancesDrawn: number;
  readonly lineLengths: readonly number[];
}

interface WidgetReport {
  readonly index: number;
  readonly expectedVisibleLines: number;
  readonly glyphInstancesDrawn: number;
}

interface FrameSample {
  readonly frame: number;
  readonly zoom: number;
  readonly detailLevel: "Text" | "Minimap";
  readonly visibleWidgets: number;
  readonly visibleGlyphs: number;
  readonly cpuMs: number;
  gpuMs: number | "unavailable";
  readonly rafIntervalMs: number;
}

interface SwitchCapture {
  readonly frame: number;
  readonly from: "Text" | "Minimap";
  readonly to: "Text" | "Minimap";
  readonly pngAfter: string;
  readonly pngNext: string;
}

interface SwitchEvent {
  readonly frame: number;
  readonly from: "Text" | "Minimap";
  readonly to: "Text" | "Minimap";
}

interface PendingSwitch {
  readonly frame: number;
  readonly from: "Text" | "Minimap";
  readonly to: "Text" | "Minimap";
  readonly pngAfter: string | undefined;
}

interface SweepResult {
  readonly thresholds: {
    readonly textToMinimapPx: number;
    readonly minimapToTextPx: number;
  };
  readonly hysteresisBandZoom: { readonly min: number; readonly max: number };
  readonly frames: readonly FrameSample[];
  readonly switches: readonly SwitchEvent[];
  readonly captureSwitches: readonly SwitchCapture[];
  readonly longFrames: readonly {
    readonly frame: number;
    readonly intervalMs: number;
  }[];
  readonly switchIntervals: readonly {
    readonly switchFrame: number;
    readonly intervals: readonly number[];
  }[];
  readonly levelFlips: number;
  readonly emptyFrames: number;
  readonly overlapDepth: "verified by depth test";
  readonly maxVisibleGlyphCount: number;
  readonly textWorstCaseZoom: number;
  readonly textWorstCaseFrame: FrameSample | undefined;
  readonly gpuFramesMeasured: number;
  readonly textGpuFramesMeasured: number;
  readonly minimapGpuP99: number | "unavailable";
  readonly minimapFrameAtThreshold: FrameSample | undefined;
  readonly minimapFrameAtFarZoom: FrameSample | undefined;
  readonly zoomSummaries: readonly ZoomSummary[];
  readonly densestText: ZoomSummary | undefined;
  readonly captureGuards: readonly CaptureGuardSample[];
}

interface MetricPercentiles {
  readonly count: number;
  readonly p50: number | "unavailable";
  readonly p95: number | "unavailable";
  readonly p99: number | "unavailable";
  readonly max: number | "unavailable";
}

interface ZoomSummary {
  readonly label: "zoom-1" | "text-threshold" | "sweep";
  readonly zoom: number;
  readonly detailLevel: "Text" | "Minimap" | "Mixed";
  readonly visibleWidgets: number;
  readonly visibleGlyphs: number;
  readonly cpuMs: MetricPercentiles;
  readonly gpuMs: MetricPercentiles;
  readonly rafIntervalMs: MetricPercentiles;
  readonly longFrames: number;
}

interface LegibilityCapture {
  readonly name: string;
  readonly dataUrl: string;
}

interface LegibilityResult {
  readonly captures: readonly LegibilityCapture[];
  readonly guards: readonly CaptureGuardSample[];
}

interface CaptureResult {
  readonly switches: readonly SwitchCapture[];
  readonly legibility: readonly LegibilityCapture[];
  readonly guards: readonly CaptureGuardSample[];
}

interface CaptureGuardSample {
  readonly name: string;
  readonly kind: "Text" | "Minimap";
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
  readonly dominantFraction: number;
  readonly gapForegroundFraction: number;
  readonly textCoverage: WidgetCoverageSummary | undefined;
}

interface GpuQuerySlot {
  readonly frame: number;
  readonly query: WebGLQuery;
}

interface SpikeApi {
  readonly datasetChecks: readonly DatasetCheck[];
  readonly prepared: {
    readonly files: number;
    readonly atlasBytes: number;
    readonly glyphInstances: number;
    readonly minimapWidth: number;
    readonly widgets: readonly WidgetReport[];
  };
  measureTiming(): Promise<SweepResult>;
  capture(): Promise<CaptureResult>;
}

interface SpikeWindow extends Window {
  spikeE?: SpikeApi;
}

const rawModules = import.meta.glob<string>(
  "../../fixtures/reference-dataset/**/*.{ts,tsx}",
  { import: "default", query: "?raw" },
);
const statusElement = requiredElement("status");
const resultsElement = requiredElement("results");
const canvas = requiredElement("scene") as HTMLCanvasElement;
const runButton = requiredElement("run") as HTMLButtonElement;
const copyButton = requiredElement("copy") as HTMLButtonElement;

let allFiles: readonly DatasetFile[] = [];
let preparedFiles: readonly PreparedFile[] = [];
let renderer: Renderer | undefined;
let latestResult: SweepResult | undefined;

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

function setStatus(message: string): void {
  statusElement.textContent = message;
}

function createScopeColors(): Record<string, number> {
  const colors: Record<string, number> = {};
  for (const rule of vs_dark.rules) {
    colors[rule.token] = TokenMetadata.getForeground(
      theme._match(rule.token).metadata,
    );
  }
  colors[""] = TokenMetadata.getForeground(theme._match("").metadata);
  return colors;
}

function createScopePalette(
  colors: Record<string, number>,
): Record<string, number> {
  const palette: Record<string, number> = {};
  [...new Set(Object.values(colors))]
    .sort((left, right) => left - right)
    .forEach((foreground, index) => {
      palette[String(foreground)] = index + 1;
    });
  return palette;
}

function createScopeRgb(): Record<string, [number, number, number]> {
  const colorMap = theme.getColorMap();
  const colors: Record<string, [number, number, number]> = {};
  colorMap.forEach((color, foreground) => {
    const value = color.toString().replace(/^#/, "");
    if (value.length !== 6) return;
    colors[String(foreground)] = [
      Number.parseInt(value.slice(0, 2), 16) / 255,
      Number.parseInt(value.slice(2, 4), 16) / 255,
      Number.parseInt(value.slice(4, 6), 16) / 255,
    ];
  });
  colors["0"] ??= [0.75, 0.78, 0.84];
  return colors;
}

// Real palette-by-rank lookup for the minimap shader (D6: "colour is looked
// up in the shader from the palette"). Rank 0 (whitespace/background) is a
// dark navy close to the widget background; ranks 1..N come from scopeRgb,
// keyed the same way as scopePalette so ranks line up with the bytes the
// worker writes into the minimap R8 texture.
function createMinimapPaletteColors(): Float32Array {
  const flat = new Float32Array(MINIMAP_PALETTE_SLOTS * 3);
  flat.set([0.05, 0.07, 0.13], 0);
  for (const [key, rank] of Object.entries(scopePalette)) {
    if (rank < 1 || rank >= MINIMAP_PALETTE_SLOTS) continue;
    const [r, g, b] = scopeRgb[key] ?? [0.75, 0.78, 0.84];
    flat.set([r, g, b], rank * 3);
  }
  return flat;
}

async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeEntries(): [string, () => Promise<string>][] {
  const entries = Object.entries(rawModules);
  if (entries.length !== DATASET_COUNT) {
    throw new Error(
      `raw dataset glob expected ${String(DATASET_COUNT)} entries, found ${String(entries.length)}`,
    );
  }
  return entries
    .map(([key, loader]): [string, () => Promise<string>] => {
      const marker = key.indexOf("reference-dataset/");
      if (marker < 0)
        throw new Error(`dataset key has no reference-dataset root: ${key}`);
      return [`/fixtures/${key.slice(marker)}`, loader];
    })
    .sort((left, right) => left[0].localeCompare(right[0]));
}

async function loadDataset(): Promise<DatasetFile[]> {
  return Promise.all(
    normalizeEntries().map(async ([fileId, load]) => {
      const text = await load();
      if (typeof text !== "string")
        throw new Error(`raw dataset entry was not text: ${fileId}`);
      return {
        fileId,
        text,
        lines: text.split("\n"),
        hash: await digest(text),
      };
    }),
  );
}

function requestTokenization(
  worker: Worker,
  file: DatasetFile,
  id: number,
): Promise<WorkerResponse> {
  const request: WorkerRequest = {
    type: "tokenize",
    id,
    contentVersion: id + 1,
    fileId: file.fileId,
    text: file.text,
    mode: "transfer",
    scopeColors,
    scopePalette,
    minimapWidth: MINIMAP_WIDTH,
    minimapMaxHeight: MINIMAP_HEIGHT,
  };
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.id !== id) return;
      worker.removeEventListener("message", onMessage);
      if (event.data.type === "error") reject(new Error(event.data.message));
      else resolve(event.data);
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage(request);
  });
}

async function prepareWorkerData(
  files: readonly DatasetFile[],
): Promise<PreparedFile[]> {
  const worker = new Worker(new URL("./tokenizer.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const prepared: PreparedFile[] = [];
    for (const [index, file] of files.entries()) {
      const result = await requestTokenization(worker, file, index);
      prepared.push({
        file,
        colors: result.colors,
        lineOffsets: result.lineOffsets,
        minimap: result.minimap,
        minimapHeight: result.minimapHeight,
      });
      if ((index + 1) % 25 === 0)
        setStatus(
          `[spike-e] worker minimaps ready: ${String(index + 1)}/${String(files.length)}`,
        );
    }
    return prepared;
  } finally {
    worker.terminate();
  }
}

interface Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly background: WebGLBuffer;
  readonly text: WebGLBuffer;
  readonly minimap: WebGLBuffer;
  readonly queryExtension: TimerQueryExtension | null;
  readonly uniforms: {
    readonly viewport: WebGLUniformLocation;
    readonly atlasSize: WebGLUniformLocation;
    readonly glyphAtlasSize: WebGLUniformLocation;
    readonly glyphRegion: WebGLUniformLocation;
    readonly zoom: WebGLUniformLocation;
    readonly dpr: WebGLUniformLocation;
    readonly camera: WebGLUniformLocation;
    readonly pass: WebGLUniformLocation;
    readonly detail: WebGLUniformLocation;
    readonly minimapAtlas: WebGLUniformLocation;
    readonly glyphAtlas: WebGLUniformLocation;
    readonly minimapPalette: WebGLUniformLocation;
  };
  readonly atlasBytes: number;
  readonly glyphInstances: number;
  readonly widgets: readonly WidgetReport[];
  readonly advance: number;
  countVisible(zoom: number): {
    readonly visibleWidgets: number;
    readonly visibleGlyphs: number;
  };
  draw(
    level: "Text" | "Minimap",
    zoom: number,
    gpuTiming: boolean,
  ): { readonly cpuMs: number; readonly gpuQuery: WebGLQuery | undefined };
  captureGuard(
    name: string,
    kind: "Text" | "Minimap",
    zoom: number,
  ): CaptureGuardSample;
}

interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    console.error(`PAGE: shader compile failed: ${message}`);
    console.error(`PAGE: shader source:\n${source}`);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertexSource = `#version 300 es
    layout(location=0) in vec2 aCorner;
    layout(location=1) in vec4 aRect;
    layout(location=2) in float aDepth;
    layout(location=3) in vec2 aRowColumn;
    layout(location=4) in vec3 aColor;
    layout(location=5) in vec4 aClip;
    uniform vec2 uViewport;
    uniform float uZoom;
    uniform float uDpr;
    uniform vec2 uCamera;
    uniform int uPass;
    uniform int uDetail;
    uniform vec2 uAtlasSize;
    uniform vec2 uGlyphAtlasSize;
    uniform vec2 uGlyphRegion;
    out vec2 vAtlasUv;
    out vec2 vGlyphUv;
    flat out float vDepth;
    flat out vec3 vColor;
    out vec2 vWorldPosition;
    flat out vec4 vClip;
    void main() {
      vec2 center = uViewport * 0.5;
      vec4 rect = aRect;
      if (uPass == 1 && uDetail == 0) rect = aRect;
      vec2 pixel = (rect.xy - uCamera) * uZoom * uDpr + center + aCorner * rect.zw * uZoom * uDpr;
      vec2 clip = pixel / uViewport * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, aDepth, 1.0);
      vWorldPosition = rect.xy + aCorner * rect.zw;
      vClip = aClip;
      // aRowColumn holds the minimap atlas tile origin during the Minimap
      // pass and the glyph atlas cell origin during the Text pass (only one
      // of the two buffers is ever bound for a given draw call).
      vAtlasUv = (aRowColumn + aCorner * vec2(256.0, 512.0)) / uAtlasSize;
      vGlyphUv = (aRowColumn + aCorner * uGlyphRegion) / uGlyphAtlasSize;
      vDepth = aDepth;
      vColor = aColor;
    }`;
  const fragmentSource = `#version 300 es
    precision highp float;
    precision highp int;
    uniform int uPass;
    uniform int uDetail;
    uniform sampler2D uMinimapAtlas;
    uniform sampler2D uGlyphAtlas;
    uniform vec3 uMinimapPalette[${String(MINIMAP_PALETTE_SLOTS)}];
    in vec2 vAtlasUv;
    in vec2 vGlyphUv;
    flat in float vDepth;
    flat in vec3 vColor;
    in vec2 vWorldPosition;
    flat in vec4 vClip;
    out vec4 outColor;
    void main() {
      if (uPass == 0) { outColor = vec4(0.05, 0.07, 0.13, 1.0); return; }
      if (uDetail == 0 &&
          (vWorldPosition.x < vClip.x ||
           vWorldPosition.x >= vClip.x + vClip.z ||
           vWorldPosition.y < vClip.y ||
           vWorldPosition.y >= vClip.y + vClip.w)) discard;
      if (uDetail == 1) {
        int index = int(texture(uMinimapAtlas, vAtlasUv).r * 255.0 + 0.5);
        outColor = vec4(uMinimapPalette[clamp(index, 0, ${String(MINIMAP_PALETTE_SLOTS - 1)})], 1.0);
      } else {
        float alpha = texture(uGlyphAtlas, vGlyphUv).r;
        if (alpha < 0.03) discard;
        outColor = vec4(vColor, alpha);
      }
    }`;
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(
    program,
    compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
  return program;
}

function createBuffer(
  gl: WebGL2RenderingContext,
  values: Float32Array,
  stride: number,
): WebGLBuffer {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
  for (let index = 1; index <= 5; index += 1) {
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(
      index,
      index === 1 ? 4 : index === 3 ? 2 : index === 4 ? 3 : index === 5 ? 4 : 1,
      gl.FLOAT,
      false,
      stride * 4,
      (index === 1
        ? 0
        : index === 2
          ? 4
          : index === 3
            ? 5
            : index === 4
              ? 7
              : 10) * 4,
    );
    gl.vertexAttribDivisor(index, 1);
  }
  return buffer;
}

function glyphSlotFor(character: string, slots: Map<string, number>): number {
  const existing = slots.get(character);
  if (existing !== undefined) return existing;
  if (slots.size >= MAX_GLYPH_SLOTS) return slots.get(GLYPH_FALLBACK) ?? 0;
  const slot = slots.size;
  slots.set(character, slot);
  return slot;
}

function buildRects(files: readonly PreparedFile[]): {
  background: Float32Array;
  text: Float32Array;
  minimap: Float32Array;
  glyphInstances: number;
  widgets: readonly WidgetGeometry[];
  advance: number;
  glyphSlots: ReadonlyMap<string, number>;
} {
  const advance = measureAdvance();
  const background = new Float32Array(files.length * INSTANCE_STRIDE);
  const minimap = new Float32Array(files.length * INSTANCE_STRIDE);
  const textValues: number[] = [];
  const widgets: WidgetGeometry[] = [];
  const glyphSlots = new Map<string, number>();
  glyphSlotFor(" ", glyphSlots);
  glyphSlotFor(GLYPH_FALLBACK, glyphSlots);
  let glyphInstances = 0;
  for (const [index, prepared] of files.entries()) {
    const column = index % GRID_COLUMNS;
    const row = Math.floor(index / GRID_COLUMNS);
    const isCluster = index < 6;
    const x = isCluster
      ? CAMERA_X - WIDGET_WIDTH / 2 + index * 28
      : column * (WIDGET_WIDTH + GRID_GAP);
    const y = isCluster
      ? CAMERA_Y - WIDGET_HEIGHT / 2 + index * 18
      : row * (WIDGET_HEIGHT + GRID_GAP);
    const width = WIDGET_WIDTH;
    const height = WIDGET_HEIGHT;
    const depth = 0.1 + index * 0.0005;
    const offset = index * INSTANCE_STRIDE;
    const clip = [x, y + HEADER_HEIGHT, width, BODY_HEIGHT];
    background.set(
      [x, y, width, height, depth, 0, 0, 0, 0, 0, ...clip],
      offset,
    );
    const atlasX = (index % 20) * MINIMAP_WIDTH;
    const atlasY = Math.floor(index / 20) * MINIMAP_HEIGHT;
    minimap.set(
      [x, y, width, height, depth, atlasX, atlasY, 0, 0, 0, ...clip],
      offset,
    );
    const glyphStart = glyphInstances;
    const lineLengths: number[] = [];
    const lines = Math.min(
      prepared.file.lines.length,
      prepared.lineOffsets.length - 1,
      Math.floor(BODY_HEIGHT / LINE_HEIGHT),
    );
    for (let line = 0; line < lines; line += 1) {
      const source = prepared.file.lines[line] ?? "";
      const lineStart = prepared.lineOffsets[line] ?? 0;
      const lineGlyphStart = glyphInstances;
      const maxColumns = Math.ceil(width / advance);
      let utf16Offset = 0;
      let column = 0;
      while (utf16Offset < source.length && column < maxColumns) {
        const codePoint = source.codePointAt(utf16Offset);
        if (codePoint === undefined) break;
        const glyph = String.fromCodePoint(codePoint);
        const glyphWidth = Math.min(advance, width - column * advance);
        if (glyphWidth <= 0) break;
        const color = scopeRgb[
          String(prepared.colors[lineStart + utf16Offset] ?? 0)
        ] ??
          scopeRgb["0"] ?? [0.75, 0.78, 0.84];
        const slot = /\s/u.test(glyph)
          ? glyphSlotFor(" ", glyphSlots)
          : glyphSlotFor(glyph, glyphSlots);
        const atlasX = (slot % GLYPH_ATLAS_COLUMNS) * GLYPH_ATLAS_CELL_SIZE;
        const atlasY =
          Math.floor(slot / GLYPH_ATLAS_COLUMNS) * GLYPH_ATLAS_CELL_SIZE;
        textValues.push(
          x + column * advance,
          y + HEADER_HEIGHT + line * LINE_HEIGHT,
          glyphWidth,
          LINE_HEIGHT,
          depth,
          atlasX,
          atlasY,
          color[0],
          color[1],
          color[2],
          ...clip,
        );
        glyphInstances += 1;
        utf16Offset += glyph.length;
        column += 1;
      }
      lineLengths.push(glyphInstances - lineGlyphStart);
    }
    widgets.push({
      index,
      x,
      y,
      width,
      height,
      glyphStart,
      glyphEnd: glyphInstances,
      expectedVisibleLines: lines,
      glyphInstancesDrawn: glyphInstances - glyphStart,
      lineLengths,
    });
  }
  return {
    background,
    minimap,
    text: new Float32Array(textValues),
    glyphInstances,
    widgets,
    advance,
    glyphSlots,
  };
}

function measureAdvance(): number {
  const measureCanvas = document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context)
    throw new Error("Canvas2D is unavailable for glyph measurement");
  context.font = `${String(FONT_SIZE)}px ${FONT_FAMILY}`;
  const advance = context.measureText("M").width;
  if (!Number.isFinite(advance) || advance <= 0)
    throw new Error("Canvas2D returned an invalid glyph advance");
  return advance;
}

function createGlyphRasterCanvas(): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined")
    return new OffscreenCanvas(GLYPH_ATLAS_WIDTH, GLYPH_ATLAS_HEIGHT);
  const element = document.createElement("canvas");
  element.width = GLYPH_ATLAS_WIDTH;
  element.height = GLYPH_ATLAS_HEIGHT;
  return element;
}

// Rasterizes exactly the glyphs used by the prepared instances (D6: alpha-only
// R8 atlas via OffscreenCanvas 2D). No UNPACK_FLIP_Y flag is set anywhere in
// this module: canvas row 0 (top) is written directly to texel row 0 and
// sampled with a matching V axis (see buildMinimap's existing, already
// correct, non-flipped convention) — spike C's whole-atlas flip bug does not
// apply here.
function buildGlyphAtlas(glyphSlots: ReadonlyMap<string, number>): Uint8Array {
  const raster = createGlyphRasterCanvas();
  const context = raster.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas2D is unavailable for glyph atlas");
  context.clearRect(0, 0, GLYPH_ATLAS_WIDTH, GLYPH_ATLAS_HEIGHT);
  context.fillStyle = "white";
  context.font = `${String(FONT_SIZE * GLYPH_RASTER_SCALE)}px ${FONT_FAMILY}`;
  context.textBaseline = "alphabetic";
  const metrics = context.measureText("Mg");
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent))
    throw new Error("Canvas2D returned invalid font bounding metrics");
  const baselineOffset =
    (LINE_HEIGHT * GLYPH_RASTER_SCALE - (ascent + descent)) / 2 + ascent;
  for (const [glyph, slot] of glyphSlots) {
    const cellX = (slot % GLYPH_ATLAS_COLUMNS) * GLYPH_ATLAS_CELL_SIZE;
    const cellY =
      Math.floor(slot / GLYPH_ATLAS_COLUMNS) * GLYPH_ATLAS_CELL_SIZE;
    const x = cellX;
    const y = cellY + baselineOffset;
    context.fillText(glyph, x, y);
  }
  const pixels = context.getImageData(
    0,
    0,
    GLYPH_ATLAS_WIDTH,
    GLYPH_ATLAS_HEIGHT,
  ).data;
  const bytes = new Uint8Array(GLYPH_ATLAS_WIDTH * GLYPH_ATLAS_HEIGHT);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = pixels[index * 4 + 3] ?? 0;
  }
  return bytes;
}

function countVisibleGeometry(
  widgets: readonly WidgetGeometry[],
  zoom: number,
  advance: number,
): { readonly visibleWidgets: number; readonly visibleGlyphs: number } {
  const width = canvas.clientWidth / zoom;
  const height = canvas.clientHeight / zoom;
  const left = CAMERA_X - width / 2;
  const right = CAMERA_X + width / 2;
  const top = CAMERA_Y - height / 2;
  const bottom = CAMERA_Y + height / 2;
  let visibleWidgets = 0;
  let visibleGlyphs = 0;
  for (const widget of widgets) {
    if (
      widget.x >= right ||
      widget.x + widget.width <= left ||
      widget.y >= bottom ||
      widget.y + widget.height <= top
    )
      continue;
    visibleWidgets += 1;
    for (const [line, lineLength] of widget.lineLengths.entries()) {
      const glyphY = widget.y + HEADER_HEIGHT + line * LINE_HEIGHT;
      if (glyphY >= bottom || glyphY + LINE_HEIGHT <= top) continue;
      const first = Math.max(
        0,
        Math.floor((left - widget.x - advance) / advance) + 1,
      );
      const last = Math.min(
        lineLength,
        Math.ceil((right - widget.x) / advance),
      );
      visibleGlyphs += Math.max(0, last - first);
    }
  }
  return { visibleWidgets, visibleGlyphs };
}

function setupRenderer(files: readonly PreparedFile[]): Renderer {
  const context = canvas.getContext("webgl2", {
    antialias: false,
    depth: true,
    preserveDrawingBuffer: true,
  });
  if (!context) throw new Error("WebGL2 is unavailable");
  const gl: WebGL2RenderingContext = context;
  const program = createProgram(gl);
  const rects = buildRects(files);
  const background = createBuffer(gl, rects.background, INSTANCE_STRIDE);
  const text = createBuffer(gl, rects.text, INSTANCE_STRIDE);
  const minimap = createBuffer(gl, rects.minimap, INSTANCE_STRIDE);
  const cornerBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const atlasColumns = 20;
  const atlasRows = 10;
  const atlasWidth = MINIMAP_WIDTH * atlasColumns;
  const atlasHeight = MINIMAP_HEIGHT * atlasRows;
  const atlas = new Uint8Array(atlasWidth * atlasHeight);
  files.forEach((file, index) => {
    const tileX = (index % atlasColumns) * MINIMAP_WIDTH;
    const tileY = Math.floor(index / atlasColumns) * MINIMAP_HEIGHT;
    for (let row = 0; row < file.minimapHeight; row += 1) {
      atlas.set(
        file.minimap.subarray(row * MINIMAP_WIDTH, (row + 1) * MINIMAP_WIDTH),
        (tileY + row) * atlasWidth + tileX,
      );
    }
  });
  const atlasTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    atlasWidth,
    atlasHeight,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    atlas,
  );
  const glyphAtlasBytes = buildGlyphAtlas(rects.glyphSlots);
  const glyphAtlasTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, glyphAtlasTexture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    GLYPH_ATLAS_WIDTH,
    GLYPH_ATLAS_HEIGHT,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    glyphAtlasBytes,
  );
  gl.useProgram(program);
  const viewport = gl.getUniformLocation(program, "uViewport");
  const atlasSize = gl.getUniformLocation(program, "uAtlasSize");
  const glyphAtlasSize = gl.getUniformLocation(program, "uGlyphAtlasSize");
  const glyphRegion = gl.getUniformLocation(program, "uGlyphRegion");
  const zoomUniform = gl.getUniformLocation(program, "uZoom");
  const dprUniform = gl.getUniformLocation(program, "uDpr");
  const camera = gl.getUniformLocation(program, "uCamera");
  const pass = gl.getUniformLocation(program, "uPass");
  const detail = gl.getUniformLocation(program, "uDetail");
  const minimapAtlas = gl.getUniformLocation(program, "uMinimapAtlas");
  const glyphAtlasUniform = gl.getUniformLocation(program, "uGlyphAtlas");
  const minimapPalette = gl.getUniformLocation(program, "uMinimapPalette");
  if (
    !viewport ||
    !atlasSize ||
    !glyphAtlasSize ||
    !glyphRegion ||
    !zoomUniform ||
    !dprUniform ||
    !camera ||
    !pass ||
    !detail ||
    !minimapAtlas ||
    !glyphAtlasUniform ||
    !minimapPalette
  )
    throw new Error("missing shader uniform");
  gl.uniform1i(minimapAtlas, 0);
  gl.uniform1i(glyphAtlasUniform, 1);
  gl.uniform2f(atlasSize, atlasWidth, atlasHeight);
  gl.uniform2f(glyphAtlasSize, GLYPH_ATLAS_WIDTH, GLYPH_ATLAS_HEIGHT);
  gl.uniform2f(
    glyphRegion,
    rects.advance * GLYPH_RASTER_SCALE,
    LINE_HEIGHT * GLYPH_RASTER_SCALE,
  );
  gl.uniform3fv(minimapPalette, createMinimapPaletteColors());
  const queryExtension = gl.getExtension(
    "EXT_disjoint_timer_query_webgl2",
  ) as TimerQueryExtension | null;
  function bindBuffer(buffer: WebGLBuffer, stride: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride * 4, 0);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride * 4, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride * 4, 20);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, stride * 4, 28);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, stride * 4, 40);
  }
  function captureGuard(
    name: string,
    kind: "Text" | "Minimap",
    zoom: number,
  ): CaptureGuardSample {
    gl.finish();
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(
      0,
      0,
      canvas.width,
      canvas.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    const pixelAt = (x: number, y: number): [number, number, number] => {
      const clampedX = Math.max(0, Math.min(canvas.width - 1, Math.round(x)));
      const clampedY = Math.max(0, Math.min(canvas.height - 1, Math.round(y)));
      const offset =
        (canvas.height - 1 - clampedY) * canvas.width * 4 + clampedX * 4;
      return [
        pixels[offset] ?? 0,
        pixels[offset + 1] ?? 0,
        pixels[offset + 2] ?? 0,
      ];
    };
    const foreground = (pixel: readonly number[]): boolean =>
      (pixel[0] ?? 0) > 24 || (pixel[1] ?? 0) > 32 || (pixel[2] ?? 0) > 48;
    const worldToPixel = (x: number, y: number): [number, number] => [
      (x - CAMERA_X) * zoom * devicePixelRatio + canvas.width / 2,
      (y - CAMERA_Y) * zoom * devicePixelRatio + canvas.height / 2,
    ];
    const histogram = new Map<string, number>();
    let sampleCount = 0;
    let dominantCount = 0;
    const sampleStep = Math.max(
      2,
      Math.floor(Math.min(canvas.width, canvas.height) / 300),
    );
    for (let y = 0; y < canvas.height; y += sampleStep) {
      for (let x = 0; x < canvas.width; x += sampleStep) {
        const pixel = pixelAt(x, y);
        const key =
          String(pixel[0] >> 4) +
          "," +
          String(pixel[1] >> 4) +
          "," +
          String(pixel[2] >> 4);
        const count = (histogram.get(key) ?? 0) + 1;
        histogram.set(key, count);
        dominantCount = Math.max(dominantCount, count);
        sampleCount += 1;
      }
    }
    let gapSamples = 0;
    let gapForeground = 0;
    const checkGap = (x: number, y: number): void => {
      const insideWidget = rects.widgets.some(
        (widget) =>
          x >= widget.x &&
          x < widget.x + widget.width &&
          y >= widget.y &&
          y < widget.y + widget.height,
      );
      const [pixelX, pixelY] = worldToPixel(x, y);
      if (
        insideWidget ||
        pixelX < 0 ||
        pixelX >= canvas.width ||
        pixelY < 0 ||
        pixelY >= canvas.height
      )
        return;
      gapSamples += 1;
      if (foreground(pixelAt(pixelX, pixelY))) gapForeground += 1;
    };
    for (let row = 0; row < 20; row += 1) {
      for (let column = 0; column < GRID_COLUMNS - 1; column += 1) {
        checkGap(
          column * (WIDGET_WIDTH + GRID_GAP) + WIDGET_WIDTH + GRID_GAP / 2,
          row * (WIDGET_HEIGHT + GRID_GAP) + WIDGET_HEIGHT / 2,
        );
      }
    }
    for (let row = 0; row < 19; row += 1) {
      for (let column = 0; column < GRID_COLUMNS; column += 1) {
        checkGap(
          column * (WIDGET_WIDTH + GRID_GAP) + WIDGET_WIDTH / 2,
          row * (WIDGET_HEIGHT + GRID_GAP) + WIDGET_HEIGHT + GRID_GAP / 2,
        );
      }
    }
    let textCoverage: CaptureGuardSample["textCoverage"] | undefined;
    if (kind === "Text" && Math.abs(zoom - 1) < 0.001) {
      const viewport: CoverageRect = {
        left: 0,
        top: 0,
        right: canvas.width,
        bottom: canvas.height,
      };
      const coverageWidgets: readonly CoverageWidget[] = rects.widgets.map(
        (widget) => {
          const [left, top] = worldToPixel(widget.x, widget.y + HEADER_HEIGHT);
          const [right, bottom] = worldToPixel(
            widget.x + widget.width,
            widget.y + HEADER_HEIGHT + BODY_HEIGHT,
          );
          return {
            index: widget.index,
            body: { left, top, right, bottom },
            lineHeight: LINE_HEIGHT * zoom * devicePixelRatio,
            lineCount: widget.lineLengths.length,
          };
        },
      );
      textCoverage = summarizeWidgetCoverage(
        coverageWidgets.map((widget) =>
          measureWidgetCoverage(widget, coverageWidgets, viewport, (x, y) =>
            foreground(pixelAt(x, y)),
          ),
        ),
      );
    }
    return {
      name,
      kind,
      zoom,
      width: canvas.width,
      height: canvas.height,
      dominantFraction: sampleCount ? dominantCount / sampleCount : 1,
      gapForegroundFraction: gapSamples ? gapForeground / gapSamples : 0,
      textCoverage,
    };
  }
  const draw = (
    level: "Text" | "Minimap",
    zoom: number,
    gpuTiming: boolean,
  ) => {
    const startedAt = performance.now();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const targetWidth = Math.max(1, Math.round(width * devicePixelRatio));
    const targetHeight = Math.max(1, Math.round(height * devicePixelRatio));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.02, 0.03, 0.08, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(program);
    gl.uniform2f(viewport, canvas.width, canvas.height);
    gl.uniform1f(zoomUniform, zoom);
    gl.uniform1f(dprUniform, devicePixelRatio);
    gl.uniform2f(camera, CAMERA_X, CAMERA_Y);
    const query = gpuTiming && queryExtension ? gl.createQuery() : undefined;
    gl.uniform1i(pass, 0);
    gl.uniform1i(detail, level === "Text" ? 0 : 1);
    bindBuffer(background, INSTANCE_STRIDE);
    if (queryExtension && query)
      gl.beginQuery(queryExtension.TIME_ELAPSED_EXT, query);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, files.length);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.uniform1i(pass, 1);
    bindBuffer(level === "Text" ? text : minimap, INSTANCE_STRIDE);
    gl.drawArraysInstanced(
      gl.TRIANGLE_STRIP,
      0,
      4,
      level === "Text" ? rects.glyphInstances : files.length,
    );
    if (queryExtension && query) gl.endQuery(queryExtension.TIME_ELAPSED_EXT);
    gl.depthMask(true);
    gl.flush();
    return { cpuMs: performance.now() - startedAt, gpuQuery: query };
  };
  // Prepare a real query after the first frame so setup work cannot contaminate the sweep.
  return {
    gl,
    program,
    background,
    text,
    minimap,
    queryExtension,
    uniforms: {
      viewport,
      atlasSize,
      glyphAtlasSize,
      glyphRegion,
      zoom: zoomUniform,
      dpr: dprUniform,
      camera,
      pass,
      detail,
      minimapAtlas,
      glyphAtlas: glyphAtlasUniform,
      minimapPalette,
    },
    atlasBytes: atlas.byteLength,
    glyphInstances: rects.glyphInstances,
    widgets: rects.widgets.map(
      ({ index, expectedVisibleLines, glyphInstancesDrawn }) => ({
        index,
        expectedVisibleLines,
        glyphInstancesDrawn,
      }),
    ),
    advance: rects.advance,
    countVisible: (zoom) =>
      countVisibleGeometry(rects.widgets, zoom, rects.advance),
    draw,
    captureGuard,
  };
}

function detailLevel(
  zoom: number,
  previous: "Text" | "Minimap",
): "Text" | "Minimap" {
  const linePx = LINE_HEIGHT * zoom * devicePixelRatio;
  if (previous === "Text" && linePx < TEXT_TO_MINIMAP_PX) return "Minimap";
  if (previous === "Minimap" && linePx > MINIMAP_TO_TEXT_PX) return "Text";
  return previous;
}

function phaseZoom(
  start: number,
  end: number,
  elapsed: number,
  duration: number,
): number {
  const progress = Math.min(1, elapsed / duration);
  return start + (end - start) * progress;
}

function metricPercentiles(values: readonly number[]): MetricPercentiles {
  if (values.length === 0)
    return {
      count: 0,
      p50: "unavailable",
      p95: "unavailable",
      p99: "unavailable",
      max: "unavailable",
    };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[
      Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))
    ] ?? 0;
  return {
    count: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function summarizeFrames(
  label: ZoomSummary["label"],
  zoom: number,
  selected: readonly FrameSample[],
): ZoomSummary {
  const levels = new Set(selected.map((value) => value.detailLevel));
  return {
    label,
    zoom,
    detailLevel: levels.size === 1 ? ([...levels][0] ?? "Text") : "Mixed",
    visibleWidgets: Math.max(
      0,
      ...selected.map((value) => value.visibleWidgets),
    ),
    visibleGlyphs: Math.max(0, ...selected.map((value) => value.visibleGlyphs)),
    cpuMs: metricPercentiles(selected.map((value) => value.cpuMs)),
    gpuMs: metricPercentiles(
      selected.flatMap((value) =>
        typeof value.gpuMs === "number" ? [value.gpuMs] : [],
      ),
    ),
    rafIntervalMs: metricPercentiles(
      selected.map((value) => value.rafIntervalMs),
    ),
    longFrames: selected.filter((value) => value.rafIntervalMs > 12.5).length,
  };
}

function readGpuQuery(
  rendererState: Renderer,
  query: WebGLQuery | undefined,
): number | "pending" | "unavailable" {
  if (!query || !rendererState.queryExtension) return "unavailable";
  const { gl, queryExtension } = rendererState;
  if (gl.getParameter(queryExtension.GPU_DISJOINT_EXT)) {
    gl.deleteQuery(query);
    return "unavailable";
  }
  if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return "pending";
  const elapsedNanoseconds = gl.getQueryParameter(
    query,
    gl.QUERY_RESULT,
  ) as number;
  gl.deleteQuery(query);
  return elapsedNanoseconds / 1_000_000;
}

function resolveGpuSlot(
  rendererState: Renderer,
  slot: GpuQuerySlot,
  frames: FrameSample[],
): boolean {
  const result = readGpuQuery(rendererState, slot.query);
  if (result === "pending") return false;
  const sample = frames[slot.frame];
  if (sample && result !== "unavailable") sample.gpuMs = result;
  return true;
}

function updateResults(result: SweepResult): void {
  latestResult = result;
  resultsElement.textContent = JSON.stringify(result);
}

async function runSweep(
  captureScreenshots: boolean,
  gpuTiming: boolean,
): Promise<SweepResult> {
  if (!renderer) throw new Error("renderer is not ready");
  const activeRenderer = renderer;
  const frames: FrameSample[] = [];
  const switches: SwitchEvent[] = [];
  const captureSwitches: SwitchCapture[] = [];
  const captureGuards: CaptureGuardSample[] = [];
  let level: "Text" | "Minimap" = "Minimap";
  let previousTime = performance.now();
  let frame = 0;
  let flips = 0;
  const emptyFrames = 0;
  let maxVisibleGlyphCount = 0;
  const gpuRing: (GpuQuerySlot | undefined)[] = Array.from(
    { length: 8 },
    () => undefined,
  );
  const phases = [
    [0.17, 1.0],
    [1.0, 0.17],
    [0.17, 1.0],
    [1.0, 0.17],
    [0.17, 1.0],
    [1.0, 0.17],
  ] as const;
  const phaseDuration = 750;
  const jitterDuration = 1300;
  const totalDuration = phases.length * phaseDuration + jitterDuration;
  const startedAt = performance.now();
  let lastSwitch: PendingSwitch | undefined;
  return new Promise((resolve) => {
    const tick = (now: number) => {
      const elapsed = now - startedAt;
      let zoom: number;
      if (elapsed < phases.length * phaseDuration) {
        const phase = Math.min(
          phases.length - 1,
          Math.floor(elapsed / phaseDuration),
        );
        const localElapsed = elapsed - phase * phaseDuration;
        const currentPhase = phases[phase] ?? phases[0];
        const [start, end] = currentPhase;
        zoom = phaseZoom(start, end, localElapsed, phaseDuration);
      } else {
        const jitterElapsed = elapsed - phases.length * phaseDuration;
        zoom = 0.238 + Math.sin(jitterElapsed / 72) * 0.014;
      }
      const nextLevel = detailLevel(zoom, level);
      const changed = nextLevel !== level;
      if (changed) {
        flips += 1;
        if (captureScreenshots)
          lastSwitch = {
            frame,
            from: level,
            to: nextLevel,
            pngAfter: undefined,
          };
        switches.push({ frame, from: level, to: nextLevel });
        level = nextLevel;
      }
      const previousFrame = frame - 3;
      if (previousFrame >= 0) {
        const previousSlot = gpuRing[previousFrame % gpuRing.length];
        if (
          previousSlot?.frame === previousFrame &&
          resolveGpuSlot(activeRenderer, previousSlot, frames)
        )
          gpuRing[previousFrame % gpuRing.length] = undefined;
      }
      const slotIndex = frame % gpuRing.length;
      const existingSlot = gpuRing[slotIndex];
      if (existingSlot && existingSlot.frame !== frame) {
        activeRenderer.gl.deleteQuery(existingSlot.query);
        gpuRing[slotIndex] = undefined;
      }
      const draw = activeRenderer.draw(level, zoom, gpuTiming);
      if (draw.gpuQuery) gpuRing[slotIndex] = { frame, query: draw.gpuQuery };
      const currentTime = performance.now();
      const rafIntervalMs = currentTime - previousTime;
      previousTime = currentTime;
      const visible = activeRenderer.countVisible(zoom);
      const visibleWidgets = visible.visibleWidgets;
      const visibleGlyphs = visible.visibleGlyphs;
      maxVisibleGlyphCount = Math.max(maxVisibleGlyphCount, visibleGlyphs);
      const sample: FrameSample = {
        frame,
        zoom,
        detailLevel: level,
        visibleWidgets,
        visibleGlyphs,
        cpuMs: draw.cpuMs,
        gpuMs: "unavailable",
        rafIntervalMs,
      };
      frames.push(sample);
      if (captureScreenshots && lastSwitch?.frame === frame) {
        lastSwitch = { ...lastSwitch, pngAfter: canvas.toDataURL("image/png") };
        captureGuards.push(
          activeRenderer.captureGuard(
            "switch-" + String(frame) + "-after",
            level,
            zoom,
          ),
        );
      } else if (
        captureScreenshots &&
        lastSwitch?.pngAfter !== undefined &&
        frame === lastSwitch.frame + 1
      ) {
        const pendingSwitch = lastSwitch;
        const pngAfter = pendingSwitch.pngAfter;
        if (pngAfter === undefined)
          throw new Error("switch capture has no after image");
        captureSwitches.push({
          frame: pendingSwitch.frame,
          from: pendingSwitch.from,
          to: pendingSwitch.to,
          pngAfter,
          pngNext: canvas.toDataURL("image/png"),
        });
        captureGuards.push(
          activeRenderer.captureGuard(
            "switch-" + String(pendingSwitch.frame) + "-next",
            level,
            zoom,
          ),
        );
        lastSwitch = undefined;
      }
      frame += 1;
      if (elapsed >= totalDuration) {
        for (const slot of gpuRing) {
          if (slot && !resolveGpuSlot(activeRenderer, slot, frames))
            activeRenderer.gl.deleteQuery(slot.query);
        }
        const textFrame = frames
          .filter((value) => value.detailLevel === "Text")
          .sort((left, right) => left.zoom - right.zoom)[0];
        const minimapFrame = frames
          .filter((value) => value.detailLevel === "Minimap")
          .sort(
            (left, right) =>
              Math.abs(left.zoom - (textFrame?.zoom ?? 0.214)) -
              Math.abs(right.zoom - (textFrame?.zoom ?? 0.214)),
          )[0];
        const farMinimapFrame = frames
          .filter((value) => value.detailLevel === "Minimap")
          .sort((left, right) => left.zoom - right.zoom)[0];
        const longFrames = frames
          .filter((value) => value.rafIntervalMs > 12.5)
          .map((value) => ({
            frame: value.frame,
            intervalMs: value.rafIntervalMs,
          }));
        const switchIntervals = switches.map((event) => ({
          switchFrame: event.frame,
          intervals: frames
            .slice(event.frame + 1, event.frame + 4)
            .map((value) => value.rafIntervalMs),
        }));
        const textThresholdZoom =
          TEXT_TO_MINIMAP_PX / (LINE_HEIGHT * devicePixelRatio);
        const minimapGpuP99 = metricPercentiles(
          frames
            .filter(
              (value) =>
                value.detailLevel === "Minimap" &&
                Math.abs(value.zoom - textThresholdZoom) <= 0.04,
            )
            .flatMap((value) =>
              typeof value.gpuMs === "number" ? [value.gpuMs] : [],
            ),
        ).p99;
        const zoomSummaries = [
          summarizeFrames(
            "zoom-1",
            1,
            frames.filter((value) => value.zoom >= 0.9),
          ),
          summarizeFrames(
            "text-threshold",
            textThresholdZoom,
            frames.filter(
              (value) =>
                value.detailLevel === "Text" &&
                value.zoom >= textThresholdZoom &&
                value.zoom <= textThresholdZoom + 0.04,
            ),
          ),
          summarizeFrames("sweep", 0.17, frames),
        ];
        resolve({
          thresholds: {
            textToMinimapPx: TEXT_TO_MINIMAP_PX,
            minimapToTextPx: MINIMAP_TO_TEXT_PX,
          },
          hysteresisBandZoom: {
            min: TEXT_TO_MINIMAP_PX / (LINE_HEIGHT * devicePixelRatio),
            max: MINIMAP_TO_TEXT_PX / (LINE_HEIGHT * devicePixelRatio),
          },
          frames,
          switches,
          captureSwitches,
          longFrames,
          switchIntervals,
          levelFlips: flips,
          emptyFrames,
          overlapDepth: "verified by depth test",
          maxVisibleGlyphCount,
          textWorstCaseZoom: textFrame?.zoom ?? 0.214,
          textWorstCaseFrame: textFrame,
          gpuFramesMeasured: frames.filter(
            (value) => typeof value.gpuMs === "number",
          ).length,
          textGpuFramesMeasured: frames.filter(
            (value) =>
              value.detailLevel === "Text" && typeof value.gpuMs === "number",
          ).length,
          minimapGpuP99,
          minimapFrameAtThreshold: minimapFrame,
          minimapFrameAtFarZoom: farMinimapFrame,
          zoomSummaries,
          densestText: zoomSummaries[1],
          captureGuards,
        });
        return;
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
}

function captureLegibility(): LegibilityResult {
  if (!renderer) throw new Error("renderer is not ready");
  const activeRenderer = renderer;
  const captures: LegibilityCapture[] = [];
  const guards: CaptureGuardSample[] = [];
  const captureFrame = (
    name: string,
    kind: "Text" | "Minimap",
    zoom: number,
  ): void => {
    activeRenderer.draw(kind, zoom, false);
    activeRenderer.gl.finish();
    if (activeRenderer.gl.isContextLost())
      console.error(`PAGE: webgl context lost before capturing ${name}`);
    captures.push({ name, dataUrl: canvas.toDataURL("image/png") });
    guards.push(activeRenderer.captureGuard(name, kind, zoom));
  };
  for (const lineHeight of [7, 9, 11, 13, 15]) {
    const zoom = lineHeight / (LINE_HEIGHT * devicePixelRatio);
    captureFrame("legibility-lh" + String(lineHeight) + ".png", "Text", zoom);
  }
  for (const lineHeight of [9, 11]) {
    const zoom = lineHeight / (LINE_HEIGHT * devicePixelRatio);
    captureFrame(
      "legibility-lh" + String(lineHeight) + "-minimap.png",
      "Minimap",
      zoom,
    );
  }
  captureFrame("legibility-zoom1-text.png", "Text", 1);
  return { captures, guards };
}

async function capture(): Promise<CaptureResult> {
  const timing = await runSweep(true, false);
  const legibility = captureLegibility();
  return {
    switches: timing.captureSwitches,
    legibility: legibility.captures,
    guards: [...timing.captureGuards, ...legibility.guards],
  };
}

async function initialize(): Promise<void> {
  setStatus("[spike-e] loading raw Reference Dataset");
  allFiles = await loadDataset();
  setStatus("[spike-e] building token colors and minimaps in worker");
  preparedFiles = await prepareWorkerData(allFiles);
  renderer = setupRenderer(preparedFiles);
  const api: SpikeApi = {
    datasetChecks: allFiles.map(({ fileId, text, hash }) => ({
      fileId,
      length: text.length,
      prefix: text.slice(0, 120),
      hash,
    })),
    prepared: {
      files: preparedFiles.length,
      atlasBytes: renderer.atlasBytes,
      glyphInstances: renderer.glyphInstances,
      minimapWidth: MINIMAP_WIDTH,
      widgets: renderer.widgets,
    },
    measureTiming: () => runSweep(false, true),
    capture,
  };
  (window as SpikeWindow).spikeE = api;
  setStatus(
    `[spike-e] ready: ${String(allFiles.length)} raw files; minimap atlas uploaded (${String(renderer.atlasBytes)} B)`,
  );
  runButton.disabled = false;
}

runButton.disabled = true;
runButton.addEventListener("click", () => {
  void (async () => {
    runButton.disabled = true;
    try {
      const result = await runSweep(false, true);
      const captureResult = await capture();
      updateResults(result);
      setStatus(
        `[spike-e] timing and capture passes complete: ${String(result.frames.length)} frames, ${String(result.levelFlips)} level flips, ${String(captureResult.legibility.length)} legibility PNGs`,
      );
    } catch (error) {
      setStatus(
        `Spike setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      runButton.disabled = false;
    }
  })();
});
copyButton.addEventListener("click", () => {
  void (async () => {
    if (latestResult)
      await navigator.clipboard.writeText(JSON.stringify(latestResult));
  })();
});

void initialize().catch((error: unknown) => {
  setStatus(
    `Spike setup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error(
    `PAGE: initialization failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
});
