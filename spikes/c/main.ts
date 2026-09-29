import {
  editor as monacoEditor,
  languages,
} from "monaco-editor/editor/editor.api.js";
import { TokenizationRegistry } from "monaco-editor/editor/common/languages.js";
import { TokenTheme } from "monaco-editor/editor/common/languages/supports/tokenization.js";
import { vs_dark } from "monaco-editor/editor/standalone/common/themes.js";
import { language as typeScriptLanguage } from "monaco-editor/languages/definitions/typescript/typescript.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "../../node_modules/monaco-editor/dev/vs/editor/editor.main.css";

const FONT_FAMILY = "Menlo";
const BASE_FONT_SIZE = 14;
const BASE_LINE_HEIGHT = 21;
const TAB_SIZE = 4;
const SCROLL_SUBPIXEL = 0.37;
const WIDGET_BACKGROUND = "#1e1e1e";
const GUTTER_COLOR = "#858585";
const GUTTER_GAP_CSS_PX = 8;
const RASTER_SCALE = 2;
const ATLAS_COLUMNS = 16;
const FALLBACK_GLYPH = "�";
// 'A' turned out to be a weak probe (its ink is nearly vertically symmetric,
// so a ~0.1 centroid gap from baseline/cell placement alone can look like a
// flip). These four are strongly asymmetric: 'g'/'y' have a descender loop
// well below the baseline (bottom-heavy ink); 'T' is a thick top bar over a
// thin stem, and '"' sits entirely above the x-height (both top-heavy).
// Deterministic and dataset-independent — always added to the atlas glyph
// set (collectGlyphSet) rather than sampled from whatever the Reference
// Dataset happens to contain. SELF_CHECK_GLYPH_SLUGS gives each a
// filesystem-safe name for the dumped PNGs (the raw glyph, e.g. '"', is not
// a safe filename component on every filesystem).
const SELF_CHECK_GLYPHS = ["g", "y", "T", '"'] as const;
const SELF_CHECK_GLYPH_SLUGS: Readonly<Record<string, string>> = {
  g: "g",
  y: "y",
  T: "T",
  '"': "quote",
};
// A pure sign check missed round 3.3's baseline bug (~0.12 cell offset,
// well within the "same half" test for these asymmetric glyphs) — compare
// the actual centroid difference too.
const SELF_CHECK_CENTROID_TOLERANCE = 0.03;
const INSTANCE_FLOATS = 11;

// The Reference Dataset's first file contains every non-ASCII line category
// (a leading tab, CJK, emoji) within its first several lines, so all three
// pixel-comparison categories stay inside the widget body at every zoom the
// harness tests, including zoom 2 where only ~14 lines fit in a 600 CSS px
// body. Verified against the on-disk fixture: line 1 is ASCII-only, line 2 has
// Привет/東京/🧭 with no tab, line 6 has a leading tab plus the same glyphs.
const SAMPLE_CATEGORIES = [
  { category: "ascii", lineNumber: 1 },
  { category: "cjkEmoji", lineNumber: 2 },
  { category: "tabs", lineNumber: 6 },
] as const;

interface DatasetFile {
  readonly relativePath: string;
  readonly text: string;
  readonly lines: readonly string[];
}

interface DatasetSourceCheck {
  readonly relativePath: string;
  readonly length: number;
  readonly prefix: string;
}

interface MonacoLineTokens {
  findTokenIndexAtOffset(offset: number): number;
  getForeground(tokenIndex: number): number;
}

interface MonacoTokenization {
  forceTokenization(lineNumber: number): void;
  getLineTokens(lineNumber: number): MonacoLineTokens;
}

interface MonacoModel {
  getLineCount(): number;
  getLineContent(lineNumber: number): string;
  getValue(): string;
  getOptions(): { readonly tabSize: number };
  updateOptions(options: { readonly tabSize?: number }): void;
  readonly tokenization: MonacoTokenization;
  undo(): void;
  dispose(): void;
}

interface MonacoPosition {
  readonly left: number;
  readonly top: number;
  readonly height: number;
}

// Only the fields this spike reads from Monaco's real FontInfo class
// (vs/editor/common/config/fontInfo.ts): ascent/descent are the font
// metrics Monaco itself centres within lineHeight, and
// typicalHalfwidthCharacterWidth is the per-column advance Monaco uses for
// monospace layout — both in CSS px at the editor's current fontSize.
// Monaco 0.57's FontInfo has no ascent/descent field at all (confirmed by
// the lead's headed run: both undefined at runtime) — only the advance is
// read from it. Baseline placement is derived separately, below.
interface MonacoFontInfo {
  readonly typicalHalfwidthCharacterWidth: number;
}

interface MonacoInstance {
  layout(dimension: { width: number; height: number }): void;
  render(forceRedraw?: boolean): void;
  updateOptions(options: Record<string, unknown>): void;
  setModel(model: MonacoModel | null): void;
  getModel(): MonacoModel | null;
  setScrollTop(scrollTop: number): void;
  getScrollTop(): number;
  getScrolledVisiblePosition(position: {
    lineNumber: number;
    column: number;
  }): MonacoPosition | null;
  getTopForLineNumber(lineNumber: number): number;
  getOption(optionId: number): MonacoFontInfo;
  executeEdits(
    source: string,
    edits: readonly {
      range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
      text: string;
    }[],
  ): void;
  focus(): void;
}

interface MonacoEditorApi {
  readonly EditorOption: { readonly fontInfo: number };
  createModel(value: string, language: string): MonacoModel;
  create(host: HTMLElement, options: Record<string, unknown>): MonacoInstance;
  setTheme(theme: string): void;
}

const monaco = { editor: monacoEditor as unknown as MonacoEditorApi };

const fallbackForeground = "#D4D4D4";
const tokenTheme = TokenTheme.createFromRawTokenTheme(vs_dark.rules, []);

function colorMap(): readonly { toString(): string }[] {
  return TokenizationRegistry.getColorMap() ?? tokenTheme.getColorMap();
}

function resolveTokenColor(colorId: number): string {
  return colorMap()[colorId]?.toString().toUpperCase() ?? fallbackForeground;
}

function hexToRgb01(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.replace(/^#/, ""), 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  ];
}

interface PerformanceActionMetrics {
  readonly action: string;
  readonly elapsedMs: number;
  readonly longTasks: readonly number[];
  readonly eventDurations: readonly number[];
  readonly maxTaskDurationMs: number;
  readonly tasksOver833Ms: number;
  readonly inputToNextPaintMs: number | null;
}

interface SwapMeasurement {
  readonly direction: "enter" | "exit";
  readonly frameMs: number;
  readonly snappedZoom: number;
  readonly lineHeightCssPx: number;
  readonly lineHeightIsWholeCssPx: boolean;
}

interface SampleGlyph {
  readonly column: number;
  readonly xOffsetCssPx: number;
  readonly advanceCssPx: number;
}

interface SampleCategory {
  readonly category: "ascii" | "cjkEmoji" | "tabs";
  readonly lineNumber: number;
  readonly text: string;
  readonly glyphs: readonly SampleGlyph[];
}

interface WideGlyphMeasurement {
  readonly glyph: string;
  readonly codePoint: number;
  // Monaco's real fallback-font advance relative to the narrow (ASCII)
  // advance — a fraction like 1.7 for CJK, NOT a rounded integer cell count.
  // Rounding to 2 cells was round 3.6's residual bug: it left 1.9-2.9 device
  // px of error per wide glyph even after the underlying measurement itself
  // was fixed.
  readonly advanceRatio: number;
  readonly deltaCssPx: number;
  // How far a naive "always 2 cells" assumption would have been from the
  // real measured delta — quantifies round 3.6's bug, not round 3.7's fix.
  readonly deviationFromDoubleWidthCssPx: number;
}

interface TabStopMeasurement {
  readonly probeText: string;
  readonly tabSizeCells: number;
  readonly ruleLeftCssPx: readonly number[];
  readonly monacoLeftCssPx: readonly number[];
  readonly maxDeviationCssPx: number;
}

interface LayoutRule {
  readonly tabSizeCells: number;
  readonly advanceCssPx: number;
  readonly gutterWidthCssPx: number;
  readonly wideGlyphs: readonly WideGlyphMeasurement[];
  readonly tabStops: TabStopMeasurement;
  readonly baseline: BaselineMeasurement;
}

interface SpikeApi {
  readonly datasetSourceCheck: DatasetSourceCheck;
  readonly datasetCount: number;
  readonly layoutRule: LayoutRule;
  readonly atlasSelfCheck: readonly AtlasSelfCheckResult[];
  readonly sample: {
    readonly cellWidthCssPx: number;
    readonly contentLeftCssPx: number;
    readonly lineHeightCssPx: number;
    readonly lineHeightIsWholeCssPx: boolean;
    readonly categories: readonly SampleCategory[];
  };
  prepareZoom(targetZoom: number): Promise<{
    readonly requestedZoom: number;
    readonly snappedZoom: number;
    readonly lineHeightCssPx: number;
    readonly lineHeightIsWholeCssPx: boolean;
    readonly widgetBody: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  }>;
  enterEditing(): Promise<SwapMeasurement>;
  exitEditing(): Promise<SwapMeasurement>;
  startAction(action: string): void;
  finishAction(): PerformanceActionMetrics;
  paste500Lines(): Promise<void>;
  undo(): Promise<void>;
  switchModels(): Promise<void>;
  getState(): {
    readonly editing: boolean;
    readonly webglVisible: boolean;
    readonly zoom: number;
    readonly lineHeightCssPx: number;
    readonly scroll: {
      readonly webglFirstVisibleLine: number;
      readonly webglOffsetCssPx: number;
      readonly monacoFirstVisibleLine: number | null;
      readonly monacoOffsetCssPx: number | null;
    };
  };
}

interface SpikeWindow extends Window {
  spikeC?: SpikeApi;
}

interface PerformanceEventLike extends PerformanceEntry {
  readonly processingStart?: number;
  readonly interactionId?: number;
}

interface AtlasSlot {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

interface GlyphAtlas {
  readonly texture: WebGLTexture;
  readonly zoom: number;
  readonly slots: ReadonlyMap<number, AtlasSlot>;
  readonly fallback: AtlasSlot;
}

interface RendererUniforms {
  readonly viewport: WebGLUniformLocation;
  readonly body: WebGLUniformLocation;
  readonly dpr: WebGLUniformLocation;
  readonly atlas: WebGLUniformLocation;
}

interface Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly quadBuffer: WebGLBuffer;
  readonly instanceBuffer: WebGLBuffer;
  readonly vao: WebGLVertexArrayObject;
  readonly uniforms: RendererUniforms;
  atlas: GlyphAtlas | null;
  visible: boolean;
}

interface LaidOutGlyph {
  readonly glyph: string;
  readonly codePoint: number;
  readonly column: number;
  // Prefix-sum position and this glyph's own measured advance, both in CSS
  // px — not an integer cell index, since Monaco does not snap wide-glyph
  // widths to whole cells (D4 LineLayout finding: CJK/emoji render at the
  // fallback font's real advance, ~1.7x the narrow advance, not 2x).
  readonly xOffsetCssPx: number;
  readonly advanceCssPx: number;
  readonly utf16Offset: number;
}

const statusElement = requiredElement("status");
const resultsElement = requiredElement("results");
const enterButton = requiredElement("enter-editing");
const exitButton = requiredElement("exit-editing");
const copyButton = requiredElement("copy-results");
const canvas = requiredElement("canvas") as HTMLCanvasElement;
const bodyElement = requiredElement("widget-body");
const monacoHost = requiredElement("monaco");

const datasetModules = import.meta.glob<string>(
  "../../fixtures/reference-dataset/**/*.{ts,tsx}",
  { import: "default", query: "?raw" },
);

const DATASET_ROOT_MARKER = "/reference-dataset/";

let files: readonly DatasetFile[] = [];
let renderer: Renderer | null = null;
let editor: MonacoInstance | null = null;
let activeModel: MonacoModel | null = null;
let currentZoom = 1;
let editing = false;
let scrollTop = SCROLL_SUBPIXEL;
let actionName = "";
let actionStartedAt = 0;
let longTaskObserver: PerformanceObserver | null = null;
let eventObserver: PerformanceObserver | null = null;
// codepoint -> advance ratio relative to the narrow (ASCII) advance, e.g.
// ~1.0 for Cyrillic, ~1.7 for CJK/emoji (Monaco's real fallback-font
// advance) — never rounded to an integer cell count.
let glyphAdvanceRatios: ReadonlyMap<number, number> = new Map();
let traceKeepAliveActive = false;
const observedLongTasks: number[] = [];
const observedEvents: number[] = [];

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element;
}

async function loadDataset(): Promise<DatasetFile[]> {
  const entries = Object.entries(datasetModules)
    .map(([key, load]) => {
      const markerIndex = key.indexOf(DATASET_ROOT_MARKER);
      if (markerIndex < 0) {
        throw new Error(
          `Reference Dataset glob key has no reference-dataset root: ${key}`,
        );
      }
      return [`/fixtures${key.slice(markerIndex)}`, load] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length !== 200) {
    throw new Error(
      `Reference Dataset glob returned ${String(entries.length)} files, expected 200`,
    );
  }
  return Promise.all(
    entries.map(async ([relativePath, load]) => {
      const text = await load();
      return { relativePath, text, lines: text.split("\n") };
    }),
  );
}

function snapZoom(targetZoom: number): number {
  const snappedLineCount = Math.max(
    1,
    Math.round(BASE_LINE_HEIGHT * targetZoom),
  );
  return snappedLineCount / BASE_LINE_HEIGHT;
}

function lineHeight(): number {
  return BASE_LINE_HEIGHT * currentZoom;
}

function lineHeightIsWholeCssPx(): boolean {
  return Number.isInteger(lineHeight());
}

function monacoFontInfo(): MonacoFontInfo {
  if (!editor) {
    throw new Error("Monaco is unavailable for font metrics");
  }
  return editor.getOption(monaco.editor.EditorOption.fontInfo);
}

// Monaco's own per-column advance, not a Canvas2D measureText guess: the two
// can differ by enough to accumulate visible drift across a long line
// (round 3.3 lead review: `</strong` vs `</stron` by column ~100). Reading
// straight from FontInfo also means this always reflects whatever fontSize
// updateOptions() last set, at every zoom, with no separate raster-scale
// divide-back to get wrong (that bug halved spike B's advance,
// spikes/b/main.ts:469).
function advanceForZoom(): number {
  const advance = monacoFontInfo().typicalHalfwidthCharacterWidth;
  if (!Number.isFinite(advance) || advance <= 0) {
    throw new Error(
      "Monaco returned an invalid typicalHalfwidthCharacterWidth",
    );
  }
  return advance;
}

function measureCellWidth(): number {
  return advanceForZoom();
}

interface BaselineMeasurement {
  readonly measuredCssPx: number | null;
  readonly formulaCssPx: number;
  readonly usedCssPx: number;
  readonly lineHeightCssPx: number;
}

// The FONT's own ascent/descent (not the ink bounds of any specific
// rendered string) is what the browser uses for CSS half-leading — the same
// font string Monaco applies to its `.view-line` spans, measured with
// fontBoundingBoxAscent/Descent (Chrome supports these; actualBoundingBox*
// measures a specific string's ink extent instead, which was round 3.3's
// baseline bug).
function fontMetricsFromCanvas2D(fontSizeCss: number): {
  readonly ascent: number;
  readonly descent: number;
} {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) {
    throw new Error("Canvas2D is unavailable for font metrics");
  }
  context.font = `normal ${String(fontSizeCss)}px ${FONT_FAMILY}`;
  const metrics = context.measureText("x");
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent <= 0) {
    throw new Error(
      `Canvas2D did not return usable fontBoundingBoxAscent/Descent (ascent=${String(ascent)}, descent=${String(descent)}) for "${FONT_FAMILY}" at ${String(fontSizeCss)}px`,
    );
  }
  return { ascent, descent };
}

function findViewLineElement(): HTMLElement | null {
  return monacoHost.querySelector<HTMLElement>(".view-line");
}

// Ground truth, not a formula: clones Monaco's OWN computed font/line-height
// onto a detached, invisible probe and reads where the browser itself places
// a zero-height, vertical-align:baseline inline box within that line box —
// exactly the CSS half-leading placement Monaco's real `.view-line` spans
// get, with nothing to derive incorrectly. Returns null (not a throw) if no
// `.view-line` exists yet to clone from; the caller falls back to the
// Canvas2D formula in that case.
// monacoHost is `display: none` for most of this spike's flow (only
// enterEditing() shows it; every zoom/layout probe otherwise runs while
// hidden — see prepareZoom). A hidden container can leave Monaco's internal
// view state degenerate: it may never render `.view-line` spans at all, and
// getScrolledVisiblePosition can return stale/identical positions for every
// column instead of null (round 3.5: every wideGlyphs entry came back
// deltaCssPx=0 — before and after the glyph resolved to the SAME `.left`,
// with no error thrown). Force the host visible and force a render
// synchronously (no `await` inside `action`, so nothing outside this
// function — including a screenshot — can ever observe the change or an
// extra painted frame) for the whole probe, then restore exactly what was
// there before.
function withVisibleMonaco<T>(action: () => T): T {
  if (!editor) {
    throw new Error("Monaco is unavailable");
  }
  const previousDisplay = monacoHost.style.display;
  monacoHost.style.display = "block";
  editor.render(true);
  try {
    return action();
  } finally {
    monacoHost.style.display = previousDisplay;
  }
}

function measureBaselineOffsetFromDom(): number | null {
  if (!editor) {
    return null;
  }
  return withVisibleMonaco(() => {
    const viewLine = findViewLineElement();
    if (!viewLine) {
      return null;
    }
    const computed = getComputedStyle(viewLine);
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.visibility = "hidden";
    container.style.pointerEvents = "none";
    container.style.left = "-99999px";
    container.style.top = "0";
    container.style.margin = "0";
    container.style.padding = "0";
    container.style.border = "0";
    container.style.fontFamily = computed.fontFamily;
    container.style.fontSize = computed.fontSize;
    container.style.fontWeight = computed.fontWeight;
    container.style.fontStyle = computed.fontStyle;
    container.style.lineHeight = computed.lineHeight;
    const probe = document.createElement("span");
    probe.style.display = "inline-block";
    probe.style.width = "0px";
    probe.style.height = "0px";
    probe.style.verticalAlign = "baseline";
    container.appendChild(probe);
    document.body.appendChild(container);
    const offset =
      probe.getBoundingClientRect().top - container.getBoundingClientRect().top;
    document.body.removeChild(container);
    return Number.isFinite(offset) ? offset : null;
  });
}

// Measures the baseline offset from the top of a `cellHeightCss`-tall line
// box both ways and prefers the DOM-measured ground truth; the Canvas2D
// formula is the fallback (and is always computed, so both are available to
// report). Fails loudly only if NEITHER produces a usable value.
function measureBaselineOffsetCssPx(
  cellHeightCss: number,
  fontSizeCss: number,
): BaselineMeasurement {
  const measuredCssPx = measureBaselineOffsetFromDom();
  const { ascent, descent } = fontMetricsFromCanvas2D(fontSizeCss);
  const formulaCssPx = (cellHeightCss - ascent - descent) / 2 + ascent;
  if (measuredCssPx === null) {
    console.log(
      `[spike-c] baseline: no .view-line to measure yet, falling back to the Canvas2D formula (${formulaCssPx.toFixed(3)}px of ${String(cellHeightCss)}px)`,
    );
  } else {
    console.log(
      `[spike-c] baseline: measured=${measuredCssPx.toFixed(3)}px formula=${formulaCssPx.toFixed(3)}px used=measured (cellHeight=${String(cellHeightCss)}px, fontSize=${String(fontSizeCss)}px)`,
    );
  }
  const usedCssPx = measuredCssPx ?? formulaCssPx;
  if (!Number.isFinite(usedCssPx) || usedCssPx <= 0) {
    throw new Error(
      `Could not determine a usable baseline offset (measured=${String(measuredCssPx)}, formula=${String(formulaCssPx)})`,
    );
  }
  return {
    measuredCssPx,
    formulaCssPx,
    usedCssPx,
    lineHeightCssPx: cellHeightCss,
  };
}

// Matches Monaco's own centering of the font box within lineHeight (D9):
// topPadding = (lineHeight - (ascent + descent)) / 2, baseline = topPadding
// + ascent (the Canvas2D-formula fallback applies this explicitly; the
// DOM-measured path gets the same quantity from the browser's own CSS
// half-leading layout instead). Returns a dimensionless fraction of
// cellHeightCss so it can be reused at any pixel scale (the real raster
// atlas, or the self-check's fixed-size probe canvas).
function monacoBaselineFraction(cellHeightCss: number): number {
  const fontSizeCss = cellHeightCss * (BASE_FONT_SIZE / BASE_LINE_HEIGHT);
  return (
    measureBaselineOffsetCssPx(cellHeightCss, fontSizeCss).usedCssPx /
    cellHeightCss
  );
}

// Tab stops land on the next multiple of tabSize (Monaco's own rule), never a
// fixed 4-column jump — spike B's uploadInstances always inserted exactly
// TAB_SIZE-1 filler spaces regardless of the current column.
// Tab stops are still a COLUMN-counting rule (Monaco's "next multiple of
// tabSize", with a wide glyph counting as 2 columns for that purpose only —
// CursorColumns.visibleColumnFromColumn), tracked here as `columnIndex`. The
// actual x position rendered on screen is a separate, real prefix sum of
// each glyph's own measured advance (`xOffsetCssPx`) — a wide glyph's
// column-counting weight (2) and its real pixel advance (~1.7x) are
// deliberately different numbers.
function layoutLine(
  line: string,
  tabSize: number,
  advance: number,
): LaidOutGlyph[] {
  const glyphs: LaidOutGlyph[] = [];
  let columnIndex = 0;
  let xOffsetCssPx = 0;
  let utf16Offset = 0;
  for (const glyph of line) {
    if (glyph === "\t") {
      const tabColumns = tabSize - (columnIndex % tabSize);
      columnIndex += tabColumns;
      xOffsetCssPx += tabColumns * advance;
      utf16Offset += 1;
      continue;
    }
    const codePoint = glyph.codePointAt(0) ?? 0;
    const ratio = glyphAdvanceRatios.get(codePoint) ?? 1;
    const glyphAdvanceCssPx = ratio * advance;
    if (glyph !== " ") {
      glyphs.push({
        glyph,
        codePoint,
        column: utf16Offset + 1,
        xOffsetCssPx,
        advanceCssPx: glyphAdvanceCssPx,
        utf16Offset,
      });
    }
    columnIndex += Math.max(1, Math.round(ratio));
    xOffsetCssPx += glyphAdvanceCssPx;
    utf16Offset += glyph.length;
  }
  return glyphs;
}

function collectGlyphSet(text: string): string[] {
  // " " and FALLBACK_GLYPH always render as blanks/tofu; digits are used by
  // the line-number gutter regardless of dataset content; SELF_CHECK_GLYPHS
  // are guaranteed present so the atlas self-check below never fails just
  // because the sampled dataset text happened not to use 'A' or 'g'.
  const set = new Set<string>([" ", FALLBACK_GLYPH, ...SELF_CHECK_GLYPHS]);
  for (const glyph of text) {
    if (glyph === "\n" || glyph === "\t") continue;
    set.add(glyph);
  }
  for (const digit of "0123456789") {
    set.add(digit);
  }
  return [...set];
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Could not create WebGL shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    console.error(`PAGE: shader compile failure: ${message}`);
    console.error(`PAGE: shader source: ${source}`);
    throw new Error(message);
  }
  return shader;
}

function requiredUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) {
    throw new Error(`Missing uniform ${name}`);
  }
  return location;
}

// An instanced glyph-atlas renderer (D6): one quad per visible glyph, sampling
// a per-zoom Canvas2D-rasterized R8 atlas texture. Replaces the round-2
// approach of compositing a whole Canvas2D frame into one textured quad, which
// was neither upright (defect 1) nor representative of the product's glyph
// path (defect 2).
function createRenderer(): Renderer {
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) {
    throw new Error("WebGL2 is unavailable");
  }
  const vertexSource = `#version 300 es
    layout(location = 0) in vec2 aCorner;
    layout(location = 1) in vec2 aCellOrigin;
    layout(location = 2) in vec2 aCellSize;
    layout(location = 3) in vec4 aAtlasRect;
    layout(location = 4) in vec3 aColor;
    uniform vec2 uViewport;
    uniform vec4 uBody;
    uniform float uDpr;
    out vec2 vUv;
    flat out vec3 vColor;
    void main() {
      vec2 cssPos = uBody.xy + aCellOrigin + aCorner * aCellSize;
      vec2 devicePos = cssPos * uDpr;
      vec2 clip = devicePos / uViewport;
      gl_Position = vec4(clip.x * 2.0 - 1.0, 1.0 - clip.y * 2.0, 0.0, 1.0);
      vUv = mix(aAtlasRect.xy, aAtlasRect.zw, aCorner);
      vColor = aColor;
    }`;
  const fragmentSource = `#version 300 es
    precision highp float;
    uniform sampler2D uAtlas;
    in vec2 vUv;
    flat in vec3 vColor;
    out vec4 outColor;
    void main() {
      float alpha = texture(uAtlas, vUv).r;
      if (alpha < 0.02) discard;
      outColor = vec4(vColor, alpha);
    }`;
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "unknown link error");
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  const vao = gl.createVertexArray();
  const quadBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  const stride = INSTANCE_FLOATS * 4;
  const attributeSpecs: readonly (readonly [number, number, number])[] = [
    [1, 2, 0],
    [2, 2, 2],
    [3, 4, 4],
    [4, 3, 8],
  ];
  for (const [location, size, offsetFloats] of attributeSpecs) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      size,
      gl.FLOAT,
      false,
      stride,
      offsetFloats * 4,
    );
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return {
    canvas,
    gl,
    program,
    quadBuffer,
    instanceBuffer,
    vao,
    uniforms: {
      viewport: requiredUniform(gl, program, "uViewport"),
      body: requiredUniform(gl, program, "uBody"),
      dpr: requiredUniform(gl, program, "uDpr"),
      atlas: requiredUniform(gl, program, "uAtlas"),
    },
    atlas: null,
    visible: true,
  };
}

interface PackedAtlasGlyph {
  readonly codePoint: number;
  readonly glyph: string;
  readonly x: number;
  readonly y: number;
  readonly widthPx: number;
}

// Left-to-right, wrapping bin packing: wide glyphs get a slot sized to their
// OWN measured advance ratio (rounded up to whole raster px), not a fixed
// 2-cell box. A row is ATLAS_COLUMNS narrow-cell-equivalents wide.
function packAtlasGlyphs(
  glyphs: readonly string[],
  narrowCellPx: number,
  cellHeightPx: number,
): {
  readonly packed: readonly PackedAtlasGlyph[];
  readonly rowWidthPx: number;
  readonly totalHeightPx: number;
} {
  const rowWidthPx = ATLAS_COLUMNS * narrowCellPx;
  const packed: PackedAtlasGlyph[] = [];
  let cursorX = 0;
  let cursorY = 0;
  for (const glyph of glyphs) {
    const codePoint = glyph.codePointAt(0) ?? 0;
    const ratio = glyphAdvanceRatios.get(codePoint) ?? 1;
    const widthPx = Math.max(1, Math.ceil(ratio * narrowCellPx));
    if (cursorX > 0 && cursorX + widthPx > rowWidthPx) {
      cursorX = 0;
      cursorY += cellHeightPx;
    }
    packed.push({ codePoint, glyph, x: cursorX, y: cursorY, widthPx });
    cursorX += widthPx;
  }
  return { packed, rowWidthPx, totalHeightPx: cursorY + cellHeightPx };
}

function buildAtlas(gl: WebGL2RenderingContext, zoom: number): GlyphAtlas {
  const source = files[0];
  if (!source) {
    throw new Error("Reference Dataset has no files");
  }
  const glyphs = collectGlyphSet(source.text);
  const advance = advanceForZoom();
  const cellHeightCss = BASE_LINE_HEIGHT * zoom;
  const narrowCellPx = Math.max(1, Math.ceil(advance * RASTER_SCALE));
  const cellHeightPx = Math.max(1, Math.ceil(cellHeightCss * RASTER_SCALE));
  const { packed, rowWidthPx, totalHeightPx } = packAtlasGlyphs(
    glyphs,
    narrowCellPx,
    cellHeightPx,
  );
  const atlasWidth = rowWidthPx;
  const atlasHeight = totalHeightPx;
  const rasterCanvas = document.createElement("canvas");
  rasterCanvas.width = atlasWidth;
  rasterCanvas.height = atlasHeight;
  const context = rasterCanvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas2D is unavailable for glyph rasterization");
  }
  context.clearRect(0, 0, atlasWidth, atlasHeight);
  context.fillStyle = "white";
  context.font = `${String(BASE_FONT_SIZE * zoom * RASTER_SCALE)}px ${FONT_FAMILY}, monospace`;
  context.textBaseline = "alphabetic";
  const baselineOffset = monacoBaselineFraction(cellHeightCss) * cellHeightPx;
  const slots = new Map<number, AtlasSlot>();
  for (const item of packed) {
    context.fillText(item.glyph, item.x, item.y + baselineOffset);
    slots.set(item.codePoint, {
      u0: item.x / atlasWidth,
      v0: item.y / atlasHeight,
      u1: (item.x + item.widthPx) / atlasWidth,
      v1: (item.y + cellHeightPx) / atlasHeight,
    });
  }
  const pixels = context.getImageData(0, 0, atlasWidth, atlasHeight).data;
  const bytes = new Uint8Array(atlasWidth * atlasHeight);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = pixels[index * 4 + 3] ?? 0;
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // UNPACK_FLIP_Y_WEBGL must stay false (the default) here: it flips the
  // WHOLE atlas image top-to-bottom at upload time, which does not just
  // invert each glyph in place — it also swaps which row's pixel data ends
  // up at a given slot's v-range, so a slot samples a DIFFERENT glyph's
  // (also inverted) pixels. Slot UVs below are computed top-down
  // (`v0 = row * cellHeightPx / atlasHeight`) to match this direct,
  // unflipped upload 1:1.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    atlasWidth,
    atlasHeight,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    bytes,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const fallback = slots.get(FALLBACK_GLYPH.codePointAt(0) ?? 0) ?? {
    u0: 0,
    v0: 0,
    u1: 0,
    v1: 0,
  };
  return { texture, zoom, slots, fallback };
}

function extractRedChannel(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const result = new Uint8Array(width * height);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = rgba[index * 4] ?? 0;
  }
  return result;
}

function extractAlphaChannel(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const result = new Uint8Array(width * height);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = rgba[index * 4 + 3] ?? 0;
  }
  return result;
}

// gl.readPixels() always returns rows bottom-to-top (a framebuffer-readback
// convention, independent of any texture-upload UNPACK_FLIP_Y_WEBGL
// setting) — flip to top-down so it lines up with Canvas2D's ImageData,
// which is always top-down. `channels` lets this flip either the single
// extracted alpha/red channel or the full RGBA readback (for the PNG dump).
function flipRowsVertically(
  source: Uint8Array,
  width: number,
  height: number,
  channels = 1,
): Uint8Array {
  const rowLength = width * channels;
  const result = new Uint8Array(rowLength * height);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = row * rowLength;
    const destinationStart = (height - 1 - row) * rowLength;
    result.set(
      source.subarray(sourceStart, sourceStart + rowLength),
      destinationStart,
    );
  }
  return result;
}

function rgbaToPngDataUrl(
  rgba: Uint8Array,
  width: number,
  height: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Atlas self-check: Canvas2D is unavailable for PNG export");
  }
  context.putImageData(
    new ImageData(new Uint8ClampedArray(rgba), width, height),
    0,
    0,
  );
  return canvas.toDataURL("image/png");
}

function inkCentroidFraction(
  bytes: Uint8Array,
  width: number,
  height: number,
): number | null {
  let weightedY = 0;
  let totalWeight = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = bytes[y * width + x] ?? 0;
      if (value < 10) continue;
      weightedY += y * value;
      totalWeight += value;
    }
  }
  return totalWeight > 0 ? weightedY / totalWeight / height : null;
}

interface AtlasSelfCheckResult {
  readonly glyph: string;
  readonly slug: string;
  readonly verdict: "match" | "mismatch" | "error";
  readonly detail: string;
  readonly gpuCentroidFraction: number | null;
  readonly referenceCentroidFraction: number | null;
  readonly gpuPngDataUrl: string | null;
  readonly referencePngDataUrl: string | null;
}

// The reference baseline is placed at the SAME fraction of `size` that
// Monaco's own ascent/descent centering puts it at within a real cell
// (monacoBaselineFraction) — not an arbitrary fixed 0.8 — so comparing GPU
// vs reference at a tight tolerance actually checks "does the GPU match
// Monaco's placement", not "does the GPU match an unrelated placement".
function referenceGlyphRender(
  glyph: string,
  size: number,
): { readonly centroidFraction: number | null; readonly pngDataUrl: string } {
  const reference = document.createElement("canvas");
  reference.width = size;
  reference.height = size;
  const referenceContext = reference.getContext("2d");
  if (!referenceContext) {
    throw new Error(
      "Atlas self-check: Canvas2D is unavailable for the reference render",
    );
  }
  const fontSizePx = size * (BASE_FONT_SIZE / BASE_LINE_HEIGHT);
  // The fraction must come from the REAL current line height (ascent/
  // descent are fixed CSS px, not proportional to the probe's own `size`),
  // then get reapplied proportionally to this size×size probe canvas.
  const baselineY = monacoBaselineFraction(lineHeight()) * size;
  referenceContext.fillStyle = "white";
  referenceContext.font = `${String(Math.round(fontSizePx))}px ${FONT_FAMILY}, monospace`;
  referenceContext.textBaseline = "alphabetic";
  referenceContext.fillText(glyph, size * 0.1, baselineY);
  const centroidFraction = inkCentroidFraction(
    extractAlphaChannel(
      referenceContext.getImageData(0, 0, size, size).data,
      size,
      size,
    ),
    size,
    size,
  );
  return { centroidFraction, pngDataUrl: reference.toDataURL("image/png") };
}

function gpuGlyphRender(
  gl: WebGL2RenderingContext,
  rendererState: Renderer,
  framebuffer: WebGLFramebuffer,
  atlasState: GlyphAtlas,
  glyph: string,
  size: number,
): { readonly centroidFraction: number | null; readonly pngDataUrl: string } {
  const codePoint = glyph.codePointAt(0) ?? 0;
  const slot = atlasState.slots.get(codePoint);
  if (!slot) {
    throw new Error(
      `glyph "${glyph}" has no atlas slot even though collectGlyphSet always adds SELF_CHECK_GLYPHS — check buildAtlas`,
    );
  }
  const record = new Float32Array([
    0,
    0,
    size,
    size,
    slot.u0,
    slot.v0,
    slot.u1,
    slot.v1,
    1,
    1,
    1,
  ]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.viewport(0, 0, size, size);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(rendererState.program);
  gl.bindVertexArray(rendererState.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, rendererState.instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, record, gl.STREAM_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasState.texture);
  gl.uniform1i(rendererState.uniforms.atlas, 0);
  gl.uniform2f(rendererState.uniforms.viewport, size, size);
  gl.uniform4f(rendererState.uniforms.body, 0, 0, size, size);
  gl.uniform1f(rendererState.uniforms.dpr, 1);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
  gl.disable(gl.BLEND);
  const raw = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const topDownRgba = flipRowsVertically(raw, size, size, 4);
  const centroidFraction = inkCentroidFraction(
    extractRedChannel(topDownRgba, size, size),
    size,
    size,
  );
  return {
    centroidFraction,
    pngDataUrl: rgbaToPngDataUrl(topDownRgba, size, size),
  };
}

// Renders each probe glyph through the real production shader into an
// offscreen framebuffer and compares the SIGN of (ink centroid - 0.5)
// against a fresh, independent Canvas2D `fillText` of the same glyph (always
// upright by construction) — not the absolute distance, since baseline/cell
// placement alone can shift a centroid by ~0.1 without any flip. Never
// throws: every failure mode (missing slot, no ink, sign mismatch, or an
// unexpected exception) becomes an "error"/"mismatch" result entry instead
// of aborting setup, so a wrong renderer still produces real captures the
// lead can look at, and a self-check bug can never block the run again.
function runAtlasSelfCheck(
  gl: WebGL2RenderingContext,
  rendererState: Renderer,
  atlasState: GlyphAtlas,
): AtlasSelfCheckResult[] {
  const size = 64;
  // drawFrame() sets the real viewport and an enabled SCISSOR_TEST bounding
  // the widget body before ever calling this function, then never touches
  // either again for the rest of that frame. Without saving/restoring:
  // (a) the still-enabled scissor (sized and positioned for the full
  // canvas) would very likely clip this 64x64 offscreen draw to nothing,
  // producing a false "no ink" result, and (b) leaving the viewport at
  // 64x64 would corrupt every real glyph drawn for the rest of that frame
  // (GL viewport state persists until something else changes it).
  const previousViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  const previousScissorEnabled = gl.isEnabled(gl.SCISSOR_TEST);
  const previousScissorBox = gl.getParameter(gl.SCISSOR_BOX) as Int32Array;
  gl.disable(gl.SCISSOR_TEST);
  const results: AtlasSelfCheckResult[] = [];
  // The render target is a fresh RGBA8 texture, deliberately not the atlas's
  // own R8 texture reused as an attachment: RGBA8 + RGBA/UNSIGNED_BYTE is
  // the one combination WebGL2 guarantees readPixels support for on every
  // driver, and the fragment shader already outputs a full RGBA colour
  // (`vec4(vColor, alpha)`), so RGBA8 costs nothing here.
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      size,
      size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("offscreen framebuffer is incomplete");
    }
    for (const glyph of SELF_CHECK_GLYPHS) {
      const slug = SELF_CHECK_GLYPH_SLUGS[glyph] ?? glyph;
      try {
        const gpu = gpuGlyphRender(
          gl,
          rendererState,
          framebuffer,
          atlasState,
          glyph,
          size,
        );
        const reference = referenceGlyphRender(glyph, size);
        if (gpu.centroidFraction === null) {
          results.push({
            glyph,
            slug,
            verdict: "error",
            detail: "GPU atlas render produced no ink at all",
            gpuCentroidFraction: null,
            referenceCentroidFraction: reference.centroidFraction,
            gpuPngDataUrl: gpu.pngDataUrl,
            referencePngDataUrl: reference.pngDataUrl,
          });
          continue;
        }
        if (reference.centroidFraction === null) {
          results.push({
            glyph,
            slug,
            verdict: "error",
            detail: "Canvas2D reference render produced no ink at all",
            gpuCentroidFraction: gpu.centroidFraction,
            referenceCentroidFraction: null,
            gpuPngDataUrl: gpu.pngDataUrl,
            referencePngDataUrl: reference.pngDataUrl,
          });
          continue;
        }
        const gpuSign = Math.sign(gpu.centroidFraction - 0.5);
        const referenceSign = Math.sign(reference.centroidFraction - 0.5);
        const signMatches = gpuSign === referenceSign;
        const centroidDelta = Math.abs(
          gpu.centroidFraction - reference.centroidFraction,
        );
        const withinTolerance = centroidDelta <= SELF_CHECK_CENTROID_TOLERANCE;
        const matches = signMatches && withinTolerance;
        const detail = !signMatches
          ? "ink centroid on the OPPOSITE side of mid-height from the Canvas2D reference — check UNPACK_FLIP_Y_WEBGL and the atlas slot v0/v1"
          : !withinTolerance
            ? `ink centroid differs from the Canvas2D reference by ${centroidDelta.toFixed(3)} of cell height (tolerance ${String(SELF_CHECK_CENTROID_TOLERANCE)}) — check the atlas baseline offset (monacoBaselineFraction / ascent-descent centering)`
            : `ink centroid matches the Canvas2D reference within ${centroidDelta.toFixed(3)} of cell height (tolerance ${String(SELF_CHECK_CENTROID_TOLERANCE)})`;
        results.push({
          glyph,
          slug,
          verdict: matches ? "match" : "mismatch",
          detail,
          gpuCentroidFraction: gpu.centroidFraction,
          referenceCentroidFraction: reference.centroidFraction,
          gpuPngDataUrl: gpu.pngDataUrl,
          referencePngDataUrl: reference.pngDataUrl,
        });
      } catch (error) {
        results.push({
          glyph,
          slug,
          verdict: "error",
          detail: error instanceof Error ? error.message : String(error),
          gpuCentroidFraction: null,
          referenceCentroidFraction: null,
          gpuPngDataUrl: null,
          referencePngDataUrl: null,
        });
      }
    }
  } catch (error) {
    results.push({
      glyph: "(setup)",
      slug: "setup",
      verdict: "error",
      detail: error instanceof Error ? error.message : String(error),
      gpuCentroidFraction: null,
      referenceCentroidFraction: null,
      gpuPngDataUrl: null,
      referencePngDataUrl: null,
    });
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    gl.viewport(
      previousViewport[0] ?? 0,
      previousViewport[1] ?? 0,
      previousViewport[2] ?? gl.drawingBufferWidth,
      previousViewport[3] ?? gl.drawingBufferHeight,
    );
    if (previousScissorEnabled) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(
        previousScissorBox[0] ?? 0,
        previousScissorBox[1] ?? 0,
        previousScissorBox[2] ?? 0,
        previousScissorBox[3] ?? 0,
      );
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }
  }
  for (const result of results) {
    console.log(
      `[spike-c] atlas self-check: glyph=${JSON.stringify(result.glyph)} verdict=${result.verdict} gpuCentroid=${result.gpuCentroidFraction?.toFixed(3) ?? "n/a"} refCentroid=${result.referenceCentroidFraction?.toFixed(3) ?? "n/a"} ${result.detail}`,
    );
  }
  return results;
}

function ensureAtlas(): GlyphAtlas {
  if (!renderer) {
    throw new Error("Renderer is not ready");
  }
  if (renderer.atlas?.zoom !== currentZoom) {
    if (renderer.atlas) {
      renderer.gl.deleteTexture(renderer.atlas.texture);
    }
    renderer.atlas = buildAtlas(renderer.gl, currentZoom);
  }
  return renderer.atlas;
}

function contentLeftCssPx(lineNumber: number): number {
  return (
    editor?.getScrolledVisiblePosition({ lineNumber, column: 1 })?.left ?? 62
  );
}

function pushLineNumberInstances(
  records: number[],
  lineNumber: number,
  contentLeft: number,
  rowY: number,
  heightCss: number,
  advance: number,
  atlas: GlyphAtlas,
): void {
  const digits = String(lineNumber);
  const [red, green, blue] = hexToRgb01(GUTTER_COLOR);
  const startX = contentLeft - GUTTER_GAP_CSS_PX - digits.length * advance;
  for (let index = 0; index < digits.length; index += 1) {
    const codePoint = digits.codePointAt(index) ?? 0;
    const slot = atlas.slots.get(codePoint) ?? atlas.fallback;
    records.push(
      startX + index * advance,
      rowY,
      advance,
      heightCss,
      slot.u0,
      slot.v0,
      slot.u1,
      slot.v1,
      red,
      green,
      blue,
    );
  }
}

function buildGlyphInstances(rect: DOMRect): {
  readonly data: Float32Array;
  readonly count: number;
} {
  const atlas = ensureAtlas();
  const advance = advanceForZoom();
  const heightCss = lineHeight();
  const firstLine = Math.max(1, Math.floor(scrollTop / heightCss) - 1);
  const lastLine = Math.min(
    2000,
    firstLine + Math.ceil(rect.height / heightCss) + 3,
  );
  const contentLeft = contentLeftCssPx(firstLine);
  const source = files[0];
  const model = activeModel;
  const tabSize = model?.getOptions().tabSize ?? TAB_SIZE;
  const records: number[] = [];
  let count = 0;
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    const rowY = (lineNumber - 1) * heightCss - scrollTop;
    pushLineNumberInstances(
      records,
      lineNumber,
      contentLeft,
      rowY,
      heightCss,
      advance,
      atlas,
    );
    count += String(lineNumber).length;
    const line = source?.lines[lineNumber - 1] ?? "";
    if (!model) continue;
    model.tokenization.forceTokenization(lineNumber);
    const tokens = model.tokenization.getLineTokens(lineNumber);
    for (const g of layoutLine(line, tabSize, advance)) {
      const slot = atlas.slots.get(g.codePoint) ?? atlas.fallback;
      const tokenIndex = tokens.findTokenIndexAtOffset(g.utf16Offset);
      const [red, green, blue] = hexToRgb01(
        resolveTokenColor(tokens.getForeground(tokenIndex)),
      );
      records.push(
        contentLeft + g.xOffsetCssPx,
        rowY,
        g.advanceCssPx,
        heightCss,
        slot.u0,
        slot.v0,
        slot.u1,
        slot.v1,
        red,
        green,
        blue,
      );
      count += 1;
    }
  }
  return { data: new Float32Array(records), count };
}

function drawFrame(): void {
  if (!renderer) {
    return;
  }
  const dpr = window.devicePixelRatio;
  const width = Math.max(1, Math.round(window.innerWidth * dpr));
  const height = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const gl = renderer.gl;
  gl.viewport(0, 0, width, height);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0.067, 0.082, 0.11, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!renderer.visible) {
    return;
  }
  const rect = bodyElement.getBoundingClientRect();
  const bodyDeviceX = Math.round(rect.left * dpr);
  const bodyDeviceY = Math.round(rect.top * dpr);
  const bodyDeviceWidth = Math.max(0, Math.round(rect.width * dpr));
  const bodyDeviceHeight = Math.max(0, Math.round(rect.height * dpr));
  // Widget body clipping: the scissor rect bounds both the background clear
  // and the glyph draw call, so nothing — including partially-scrolled edge
  // lines — can paint outside the widget body.
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(
    bodyDeviceX,
    height - bodyDeviceY - bodyDeviceHeight,
    bodyDeviceWidth,
    bodyDeviceHeight,
  );
  const [bgRed, bgGreen, bgBlue] = hexToRgb01(WIDGET_BACKGROUND);
  gl.clearColor(bgRed, bgGreen, bgBlue, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const { data, count } = buildGlyphInstances(rect);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.useProgram(renderer.program);
  gl.bindVertexArray(renderer.vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ensureAtlas().texture);
  gl.uniform1i(renderer.uniforms.atlas, 0);
  gl.uniform2f(renderer.uniforms.viewport, width, height);
  gl.uniform4f(
    renderer.uniforms.body,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
  );
  gl.uniform1f(renderer.uniforms.dpr, dpr);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  if (count > 0) {
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.disable(gl.SCISSOR_TEST);
}

function configureEditor(): void {
  const first = files[0];
  if (!first) {
    throw new Error("Reference Dataset has no files");
  }
  languages.register({ id: "typescript" });
  languages.setMonarchTokensProvider("typescript", typeScriptLanguage);
  activeModel = monaco.editor.createModel(first.text, "typescript");
  activeModel.tokenization.forceTokenization(activeModel.getLineCount());
  editor = monaco.editor.create(monacoHost, {
    model: activeModel,
    automaticLayout: false,
    fontFamily: FONT_FAMILY,
    fontSize: BASE_FONT_SIZE,
    lineHeight: BASE_LINE_HEIGHT,
    fontLigatures: false,
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    wordWrap: "off",
    codeLens: false,
    lineNumbers: "on",
    lineNumbersMinChars: 5,
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 0,
    renderLineHighlight: "none",
    cursorBlinking: "solid",
    cursorStyle: "line-thin",
    renderWhitespace: "none",
    renderControlCharacters: false,
    selectionHighlight: false,
    occurrencesHighlight: false,
    matchBrackets: "never",
    guides: { indentation: false, bracketPairs: false },
    renderValidationDecorations: "off",
    semanticHighlighting: { enabled: false },
    scrollBeyondLastLine: false,
  });
  monaco.editor.setTheme("vs-dark");
  monacoHost.classList.add("capture-clean");
  layoutEditor();
}

function layoutEditor(): void {
  editor?.layout({
    width: bodyElement.clientWidth,
    height: bodyElement.clientHeight,
  });
}

function frame(): Promise<number> {
  return new Promise((resolve) => {
    const started = performance.now();
    requestAnimationFrame(() => {
      resolve(performance.now() - started);
    });
  });
}

function collectNonAsciiCodePoints(text: string): number[] {
  const set = new Set<number>();
  for (const glyph of text) {
    const codePoint = glyph.codePointAt(0);
    if (codePoint !== undefined && codePoint > 127) {
      set.add(codePoint);
    }
  }
  return [...set].sort((left, right) => left - right);
}

function findFirstOccurrence(
  codePoint: number,
): { readonly lineNumber: number; readonly utf16Offset: number } | null {
  const lines = files[0]?.lines ?? [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    let offset = 0;
    for (const glyph of line) {
      if (glyph.codePointAt(0) === codePoint) {
        return { lineNumber: index + 1, utf16Offset: offset };
      }
      offset += glyph.length;
    }
  }
  return null;
}

// Every non-ASCII codepoint in the whole 200-file Reference Dataset (9 total:
// 6 Cyrillic letters, 2 CJK ideographs, 1 emoji — verified by scanning every
// fixture) already occurs in file 0's first ~22 lines, so this measures each
// one exactly against Monaco's own layout instead of assuming a East-Asian-
// width heuristic.
function measureWideGlyphs(advance: number): WideGlyphMeasurement[] {
  if (!editor) {
    throw new Error("Monaco is unavailable for the wide-glyph probe");
  }
  const codePoints = collectNonAsciiCodePoints(files[0]?.text ?? "");
  return codePoints.map((codePoint) => {
    const glyph = String.fromCodePoint(codePoint);
    const location = findFirstOccurrence(codePoint);
    if (!location) {
      return {
        glyph,
        codePoint,
        advanceRatio: 1,
        deltaCssPx: advance,
        deviationFromDoubleWidthCssPx: advance,
      };
    }
    const column = location.utf16Offset + 1;
    const afterColumn = column + glyph.length;
    const lineContent = editor?.getModel()?.getLineContent(location.lineNumber);
    const before = editor?.getScrolledVisiblePosition({
      lineNumber: location.lineNumber,
      column,
    });
    const after = editor?.getScrolledVisiblePosition({
      lineNumber: location.lineNumber,
      column: afterColumn,
    });
    console.log(
      `[spike-c] wide-glyph probe: glyph=${JSON.stringify(glyph)} U+${codePoint.toString(16).toUpperCase()} line=${String(location.lineNumber)} col=${String(column)}->${String(afterColumn)} lineLength=${String(lineContent?.length ?? -1)} lineHasGlyph=${String(lineContent?.codePointAt(location.utf16Offset) === codePoint)} before.left=${String(before?.left)} after.left=${String(after?.left)}`,
    );
    if (!before || !after) {
      // A silent 0 delta here previously defaulted every wide glyph to
      // cells=1 (Math.max(1, Math.round(0 / advance))), which is exactly
      // the bug that made CJK/emoji render squeezed/clipped — Monaco had
      // not finished rendering this line yet when the probe ran.
      throw new Error(
        `getScrolledVisiblePosition returned null for glyph "${glyph}" (U+${codePoint.toString(16).toUpperCase()}) at line ${String(location.lineNumber)} — call this after the editor has actually rendered (editor.render(true) + a frame)`,
      );
    }
    const deltaCssPx = after.left - before.left;
    if (deltaCssPx === 0) {
      // Even a narrow (1-cell) glyph must have a non-zero advance — an
      // exact 0 means before/after resolved to the SAME position, which is
      // Monaco returning degenerate (not null) positions rather than a
      // measurement genuinely finding a zero-width glyph.
      throw new Error(
        `getScrolledVisiblePosition returned the SAME left (${String(before.left)}) for column ${String(column)} and ${String(afterColumn)} on line ${String(location.lineNumber)} (glyph "${glyph}") — Monaco is not laid out as expected; check monacoHost visibility and that this is the model just set`,
      );
    }
    const advanceRatio = deltaCssPx / advance;
    return {
      glyph,
      codePoint,
      advanceRatio,
      deltaCssPx,
      deviationFromDoubleWidthCssPx: Math.abs(deltaCssPx - 2 * advance),
    };
  });
}

// The Reference Dataset only has leading tabs (verified: no mid-line tab in
// any of the 200 fixture files). A synthetic probe line is the only way to
// check the "next multiple of tabSize" rule where the starting column is not
// already a multiple of tabSize.
function measureTabStops(
  tabSizeCells: number,
  advance: number,
): TabStopMeasurement {
  if (!editor || !activeModel) {
    throw new Error("Monaco is unavailable for the tab-stop probe");
  }
  const probeText = "ab\tcd\tefgh";
  const previousModel = activeModel;
  const previousScrollTop = editor.getScrollTop();
  const probeModel = monaco.editor.createModel(probeText, "typescript");
  probeModel.updateOptions({ tabSize: tabSizeCells });
  editor.setModel(probeModel);
  editor.setScrollTop(0);
  // setModel schedules Monaco's internal re-render rather than completing it
  // synchronously; without forcing it, getScrolledVisiblePosition below can
  // return null for a line that was never actually measured yet.
  editor.render(true);
  // detectIndentation runs per model, not per editor — the probe model's own
  // tabSize can differ from the real file's (passed in as `tabSizeCells`),
  // and the "rule" below must match whatever Monaco is actually applying to
  // THIS model, not the caller's.
  const probeTabSizeCells = probeModel.getOptions().tabSize;
  const basePosition = editor.getScrolledVisiblePosition({
    lineNumber: 1,
    column: 1,
  });
  if (!basePosition) {
    editor.setModel(previousModel);
    editor.setScrollTop(previousScrollTop);
    probeModel.dispose();
    throw new Error(
      "getScrolledVisiblePosition returned null for the tab-stop probe's column 1 — the probe model may not have rendered yet",
    );
  }
  const base = basePosition.left;
  const ruleLeftCssPx: number[] = [0];
  const monacoLeftCssPx: number[] = [0];
  let expandedColumn = 0;
  let sourceColumn = 1;
  for (const glyph of probeText) {
    if (glyph === "\t") {
      expandedColumn +=
        probeTabSizeCells - (expandedColumn % probeTabSizeCells);
    } else {
      expandedColumn += 1;
    }
    sourceColumn += glyph.length;
    const position = editor.getScrolledVisiblePosition({
      lineNumber: 1,
      column: sourceColumn,
    });
    if (!position) {
      editor.setModel(previousModel);
      editor.setScrollTop(previousScrollTop);
      probeModel.dispose();
      throw new Error(
        `getScrolledVisiblePosition returned null for the tab-stop probe's column ${String(sourceColumn)}`,
      );
    }
    ruleLeftCssPx.push(expandedColumn * advance);
    monacoLeftCssPx.push(position.left - base);
  }
  editor.setModel(previousModel);
  editor.setScrollTop(previousScrollTop);
  probeModel.dispose();
  const deviations = ruleLeftCssPx.map((value, index) =>
    Math.abs(value - (monacoLeftCssPx[index] ?? 0)),
  );
  return {
    probeText,
    tabSizeCells: probeTabSizeCells,
    ruleLeftCssPx,
    monacoLeftCssPx,
    maxDeviationCssPx: Math.max(...deviations, 0),
  };
}

function measureLayoutRule(): LayoutRule {
  if (!editor || !activeModel) {
    throw new Error("Monaco is unavailable for the layout probe");
  }
  // Every sub-probe below queries getScrolledVisiblePosition (directly, or
  // via measureBaselineOffsetCssPx's DOM probe) — all of it needs Monaco
  // actually laid out, which a `display: none` monacoHost does not
  // guarantee (round 3.5: every wideGlyphs entry silently measured a 0 px
  // delta instead of null or a real width).
  return withVisibleMonaco(() => {
    if (!editor || !activeModel) {
      throw new Error("Monaco is unavailable for the layout probe");
    }
    const advance = advanceForZoom();
    const tabSizeCells = activeModel.getOptions().tabSize;
    const gutterWidthCssPx = contentLeftCssPx(1);
    const wideGlyphs = measureWideGlyphs(advance);
    const tabStops = measureTabStops(tabSizeCells, advance);
    const baseline = measureBaselineOffsetCssPx(lineHeight(), BASE_FONT_SIZE);
    return {
      tabSizeCells,
      advanceCssPx: advance,
      gutterWidthCssPx,
      wideGlyphs,
      tabStops,
      baseline,
    };
  });
}

interface ScrollMeasurement {
  readonly webglFirstVisibleLine: number;
  readonly webglOffsetCssPx: number;
  readonly monacoFirstVisibleLine: number | null;
  readonly monacoOffsetCssPx: number | null;
}

function currentScrollState(): ScrollMeasurement {
  const heightCss = lineHeight();
  const firstVisible = Math.floor(scrollTop / heightCss) + 1;
  const webglOffset = scrollTop - (firstVisible - 1) * heightCss;
  const monacoTop = editor?.getScrollTop() ?? null;
  if (monacoTop === null) {
    return {
      webglFirstVisibleLine: firstVisible,
      webglOffsetCssPx: webglOffset,
      monacoFirstVisibleLine: null,
      monacoOffsetCssPx: null,
    };
  }
  const monacoFirstVisible = Math.floor(monacoTop / heightCss) + 1;
  return {
    webglFirstVisibleLine: firstVisible,
    webglOffsetCssPx: webglOffset,
    monacoFirstVisibleLine: monacoFirstVisible,
    monacoOffsetCssPx: monacoTop - (monacoFirstVisible - 1) * heightCss,
  };
}

function observeActions(): void {
  longTaskObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime >= actionStartedAt) {
        observedLongTasks.push(entry.duration);
      }
    }
  });
  longTaskObserver.observe({ type: "longtask", buffered: true });
  eventObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceEventLike[]) {
      if (entry.startTime >= actionStartedAt && entry.duration >= 16) {
        observedEvents.push(entry.duration);
      }
    }
  });
  try {
    eventObserver.observe({
      type: "event",
      buffered: true,
      durationThreshold: 16,
    } as PerformanceObserverInit & { durationThreshold: number });
  } catch {
    eventObserver.disconnect();
    eventObserver = null;
  }
}

function stopObservers(): void {
  longTaskObserver?.disconnect();
  eventObserver?.disconnect();
  longTaskObserver = null;
  eventObserver = null;
}

// Some actions (paste, undo) complete faster than a single composited
// frame, so their CDP trace window can end up with zero PipelineReporter
// events to parse. Forcing a real Monaco redraw every rAF tick for the
// duration of the traced action guarantees actual frame submissions inside
// that window without touching the pixel-comparison captures, which happen
// in an earlier, separate phase of the run.
function traceKeepAliveTick(): void {
  if (!traceKeepAliveActive) {
    return;
  }
  editor?.render(true);
  requestAnimationFrame(traceKeepAliveTick);
}

function startTraceKeepAlive(): void {
  if (traceKeepAliveActive) {
    return;
  }
  traceKeepAliveActive = true;
  requestAnimationFrame(traceKeepAliveTick);
}

function stopTraceKeepAlive(): void {
  traceKeepAliveActive = false;
}

function actionMetrics(): PerformanceActionMetrics {
  return {
    action: actionName,
    elapsedMs: performance.now() - actionStartedAt,
    longTasks: [...observedLongTasks],
    eventDurations: [...observedEvents],
    // The Long Tasks API (`type: "longtask"`) only reports tasks >= 50ms by
    // spec, so it is not a source of truth for an 8.33ms budget — kept here
    // only as a supplementary in-page signal. The authoritative numbers come
    // from trace-analysis.mjs parsing the recorded Chrome trace (measure.ts).
    maxTaskDurationMs: Math.max(...observedLongTasks, 0),
    tasksOver833Ms: observedLongTasks.filter((duration) => duration > 8.33)
      .length,
    inputToNextPaintMs:
      observedEvents.length > 0 ? Math.max(...observedEvents) : null,
  };
}

function createApi(
  sourceCheck: DatasetSourceCheck,
  layoutRule: LayoutRule,
  atlasSelfCheck: readonly AtlasSelfCheckResult[],
): SpikeApi {
  const api: SpikeApi = {
    datasetSourceCheck: sourceCheck,
    datasetCount: files.length,
    layoutRule,
    atlasSelfCheck,
    get sample() {
      const tabSize = activeModel?.getOptions().tabSize ?? TAB_SIZE;
      const advance = measureCellWidth();
      return {
        cellWidthCssPx: advance,
        contentLeftCssPx: contentLeftCssPx(SAMPLE_CATEGORIES[0].lineNumber),
        lineHeightCssPx: lineHeight(),
        lineHeightIsWholeCssPx: lineHeightIsWholeCssPx(),
        categories: SAMPLE_CATEGORIES.map(({ category, lineNumber }) => ({
          category,
          lineNumber,
          text: files[0]?.lines[lineNumber - 1] ?? "",
          glyphs: layoutLine(
            files[0]?.lines[lineNumber - 1] ?? "",
            tabSize,
            advance,
          ).map((glyph) => ({
            column: glyph.column,
            xOffsetCssPx: glyph.xOffsetCssPx,
            advanceCssPx: glyph.advanceCssPx,
          })),
        })),
      };
    },
    async prepareZoom(targetZoom) {
      currentZoom = snapZoom(targetZoom);
      scrollTop = SCROLL_SUBPIXEL;
      editing = false;
      if (editor) {
        editor.updateOptions({
          fontSize: BASE_FONT_SIZE * currentZoom,
          lineHeight: Math.round(lineHeight()),
        });
        editor.setScrollTop(scrollTop);
      }
      if (renderer) {
        renderer.visible = true;
      }
      monacoHost.style.display = "none";
      drawFrame();
      await frame();
      return {
        requestedZoom: targetZoom,
        snappedZoom: currentZoom,
        lineHeightCssPx: lineHeight(),
        lineHeightIsWholeCssPx: lineHeightIsWholeCssPx(),
        widgetBody: (() => {
          const rect = bodyElement.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        })(),
      };
    },
    async enterEditing() {
      if (editing || !editor) {
        throw new Error("Editing is already active or Monaco is unavailable");
      }
      const started = performance.now();
      editing = true;
      editor.updateOptions({
        fontSize: BASE_FONT_SIZE * currentZoom,
        lineHeight: Math.round(lineHeight()),
      });
      editor.setScrollTop(scrollTop);
      editor.render(true);
      if (renderer) {
        renderer.visible = false;
      }
      monacoHost.style.display = "block";
      layoutEditor();
      editor.focus();
      drawFrame();
      await frame();
      return {
        direction: "enter",
        frameMs: performance.now() - started,
        snappedZoom: currentZoom,
        lineHeightCssPx: lineHeight(),
        lineHeightIsWholeCssPx: lineHeightIsWholeCssPx(),
      };
    },
    async exitEditing() {
      if (!editing || !editor) {
        throw new Error("Editing is not active");
      }
      const started = performance.now();
      scrollTop = editor.getScrollTop();
      editing = false;
      monacoHost.style.display = "none";
      if (renderer) {
        renderer.visible = true;
      }
      drawFrame();
      await frame();
      return {
        direction: "exit",
        frameMs: performance.now() - started,
        snappedZoom: currentZoom,
        lineHeightCssPx: lineHeight(),
        lineHeightIsWholeCssPx: lineHeightIsWholeCssPx(),
      };
    },
    startAction(action) {
      actionName = action;
      actionStartedAt = performance.now();
      performance.mark(`spike-c-${action}-start`);
      observedLongTasks.length = 0;
      observedEvents.length = 0;
      stopObservers();
      observeActions();
      startTraceKeepAlive();
    },
    finishAction() {
      const metrics = actionMetrics();
      performance.mark(`spike-c-${actionName}-end`);
      stopObservers();
      stopTraceKeepAlive();
      return metrics;
    },
    async paste500Lines() {
      if (!editor || !activeModel) {
        throw new Error("Monaco is unavailable");
      }
      const lineText = "// pasted line with JSX <Widget value={42} />\n";
      const pasted = lineText.repeat(500);
      const endLine = activeModel.getLineCount();
      const endColumn = activeModel.getLineContent(endLine).length + 1;
      editor.executeEdits("spike-c-paste", [
        {
          range: {
            startLineNumber: endLine,
            startColumn: endColumn,
            endLineNumber: endLine,
            endColumn,
          },
          text: pasted,
        },
      ]);
      editor.render(true);
      await frame();
    },
    async undo() {
      if (!activeModel) {
        throw new Error("Monaco model is unavailable");
      }
      activeModel.undo();
      editor?.render(true);
      await frame();
    },
    async switchModels() {
      if (!editor || !activeModel) {
        throw new Error("Monaco models are unavailable");
      }
      const oldModel = activeModel;
      const nextModel = monaco.editor.createModel(
        files[1]?.text ?? files[0]?.text ?? "",
        "typescript",
      );
      editor.setModel(nextModel);
      activeModel = nextModel;
      oldModel.dispose();
      editor.setScrollTop(scrollTop);
      editor.render(true);
      await frame();
    },
    getState() {
      return {
        editing,
        webglVisible: renderer?.visible ?? false,
        zoom: currentZoom,
        lineHeightCssPx: lineHeight(),
        scroll: currentScrollState(),
      };
    },
  };
  return api;
}

function renderResults(api: SpikeApi): void {
  resultsElement.textContent = JSON.stringify(
    {
      datasetCount: api.datasetCount,
      source: api.datasetSourceCheck,
      layoutRule: api.layoutRule,
      sample: api.sample,
      state: api.getState(),
    },
    null,
    2,
  );
}

copyButton.addEventListener("click", () => {
  void navigator.clipboard.writeText(resultsElement.textContent).then(() => {
    statusElement.textContent = "Results copied as JSON.";
  });
});

enterButton.addEventListener("click", () => {
  const api = (window as SpikeWindow).spikeC;
  if (!api) return;
  void api.enterEditing().then((swap) => {
    statusElement.textContent = `Editing entered in ${swap.frameMs.toFixed(2)} ms at zoom ${swap.snappedZoom.toFixed(4)}.`;
  });
});

exitButton.addEventListener("click", () => {
  const api = (window as SpikeWindow).spikeC;
  if (!api) return;
  void api.exitEditing().then((swap) => {
    statusElement.textContent = `Editing exited in ${swap.frameMs.toFixed(2)} ms.`;
  });
});

window.addEventListener("resize", () => {
  layoutEditor();
  drawFrame();
});

async function initialize(): Promise<void> {
  try {
    (
      globalThis as typeof globalThis & {
        MonacoEnvironment?: { getWorker: () => Worker };
      }
    ).MonacoEnvironment = { getWorker: () => new EditorWorker() };
    files = await loadDataset();
    renderer = createRenderer();
    configureEditor();
    // configureEditor()'s layout() call schedules Monaco's internal
    // re-render rather than completing it synchronously. Querying
    // getScrolledVisiblePosition (inside measureLayoutRule) before that
    // finishes can return null for every line, which previously fell back
    // to a silent 0 px delta and made every wide glyph measure as 1 cell —
    // force a render and wait a frame so the probes see real positions.
    editor?.render(true);
    await frame();
    const layoutRule = measureLayoutRule();
    const nonAscii = collectNonAsciiCodePoints(files[0]?.text ?? "");
    glyphAdvanceRatios = new Map(
      layoutRule.wideGlyphs.map((entry) => [
        entry.codePoint,
        entry.advanceRatio,
      ]),
    );
    if (glyphAdvanceRatios.size !== nonAscii.length) {
      throw new Error(
        `Layout probe measured ${String(glyphAdvanceRatios.size)} of ${String(nonAscii.length)} non-ASCII codepoints`,
      );
    }
    drawFrame();
    // Non-fatal by design (runAtlasSelfCheck never throws): a wrong-looking
    // renderer must still produce real captures for the lead to look at,
    // not abort setup on what might be a bug in the check itself.
    const atlasSelfCheck = runAtlasSelfCheck(
      renderer.gl,
      renderer,
      ensureAtlas(),
    );
    const first = files[0];
    if (!first) {
      throw new Error("Reference Dataset has no files");
    }
    const api = createApi(
      {
        relativePath: first.relativePath,
        length: first.text.length,
        prefix: first.text.slice(0, 128),
      },
      layoutRule,
      atlasSelfCheck,
    );
    (window as SpikeWindow).spikeC = api;
    statusElement.textContent = `Dataset ready: ${String(files.length)} files × 2000 lines. WebGL2 and Monaco are ready.`;
    renderResults(api);
  } catch (error) {
    statusElement.textContent = `Spike setup failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`PAGE: setup failure: ${statusElement.textContent}`);
  }
}

void initialize();
