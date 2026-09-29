import * as monacoRuntime from "monaco-editor";
import "../../node_modules/monaco-editor/dev/vs/editor/editor.main.css";

const FILE_COUNT = 200;
const FONT_FAMILY = "Menlo";
const FONT_SIZE = 14;
const LINE_HEIGHT = 21;
const TAB_SIZE = 4;
const RASTER_SCALE = 2;
const ATLAS_COLUMNS = 16;
const ATLAS_ROWS = 16;
const ATLAS_CELL_SIZE = 32 * RASTER_SCALE;
const ATLAS_SIZE = ATLAS_COLUMNS * ATLAS_CELL_SIZE;
const ATLAS_GLYPH_WIDTH = 20 * RASTER_SCALE;
const ATLAS_GLYPH_HEIGHT = 32 * RASTER_SCALE;
const MAX_ATLAS_SLOTS = ATLAS_COLUMNS * ATLAS_ROWS;
const MAX_RECORDED_FRAMES = 4096;
const QUERY_RING_SIZE = 8;
const PALETTE = new Float32Array([
  0.82, 0.86, 0.94, 1, 0.98, 0.7, 0.45, 1, 0.58, 0.83, 0.99, 1, 0.75, 0.62,
  0.98, 1, 0.55, 0.89, 0.7, 1, 0.98, 0.84, 0.43, 1, 0.95, 0.58, 0.67, 1, 0.72,
  0.78, 0.86, 1,
]);

type RasterContext =
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface DatasetFile {
  readonly relativePath: string;
  readonly text: string;
  readonly lines: readonly string[];
}

interface AtlasData {
  readonly bytes: Uint8Array;
  readonly slots: ReadonlyMap<string, number>;
  readonly cellSize: number;
  readonly columns: number;
}

interface MetricSummary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

interface MonacoCrossCheck {
  readonly fontFamily: string;
  readonly fontSizeCssPx: number;
  readonly lineHeightCssPx: number;
  readonly maxGlyphXDeviationCssPx: number;
  readonly maxBaselineDeviationCssPx: number;
  readonly sampledLine: number;
  readonly sampledText: string;
}

export interface MeasurementResult {
  readonly glyphCount: number;
  readonly durationMs: number;
  readonly frameCount: number;
  readonly drawCalls: number;
  readonly devicePixelRatio: number;
  readonly cpuFrameMs: MetricSummary;
  readonly rafIntervalMs: MetricSummary;
  readonly rafIntervals: readonly number[];
  readonly gpuFrameMs: MetricSummary | "unavailable";
  readonly gpuTimerQuery: "EXT_disjoint_timer_query_webgl2" | "unavailable";
}

interface SpikeApi {
  measure(glyphCount: number, durationMs: number): Promise<MeasurementResult>;
  readonly monacoCrossCheck: MonacoCrossCheck;
  readonly datasetSourceCheck: DatasetSourceCheck;
}

interface DatasetSourceCheck {
  readonly relativePath: string;
  readonly length: number;
  readonly prefix: string;
}

interface SpikeWindow extends Window {
  spikeB?: SpikeApi;
}

interface MonacoFontInfo {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
}

interface MonacoModel {
  getLineCount(): number;
  getLineContent(lineNumber: number): string;
}

interface MonacoInstance {
  layout(dimension: { width: number; height: number }): void;
  render(forceRedraw?: boolean): void;
  getOption(option: number): MonacoFontInfo;
  getScrolledVisiblePosition(position: {
    lineNumber: number;
    column: number;
  }): { left: number; top: number; height: number } | null;
  getTopForLineNumber(lineNumber: number): number;
}

interface MonacoEditorApi {
  readonly EditorOption: { readonly fontInfo: number };
  createModel(value: string, language: string): MonacoModel;
  create(host: HTMLElement, options: Record<string, unknown>): MonacoInstance;
}

const monaco = monacoRuntime as unknown as { editor: MonacoEditorApi };

interface RendererState {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly vao: WebGLVertexArrayObject;
  readonly instanceBuffer: WebGLBuffer;
  readonly widgetTexture: WebGLTexture;
  readonly atlasTexture: WebGLTexture;
  readonly atlas: AtlasData;
  readonly advance: number;
  readonly queryExtension: TimerQueryExtension | null;
  readonly queries: readonly WebGLQuery[];
  readonly queryConsumed: boolean[];
  readonly queryTarget: number;
  readonly queryResult: number;
  readonly queryAvailable: number;
  readonly uniform: RendererUniforms;
  instanceCount: number;
  queryCursor: number;
}

interface RendererUniforms {
  readonly viewport: WebGLUniformLocation;
  readonly camera: WebGLUniformLocation;
  readonly dpr: WebGLUniformLocation;
  readonly advance: WebGLUniformLocation;
  readonly lineHeight: WebGLUniformLocation;
  readonly atlas: WebGLUniformLocation;
  readonly atlasColumns: WebGLUniformLocation;
  readonly atlasCellSize: WebGLUniformLocation;
  readonly atlasRegion: WebGLUniformLocation;
  readonly widgetTable: WebGLUniformLocation;
  readonly palette: WebGLUniformLocation;
}

interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

const statusElement = requiredElement("status");
const resultsElement = requiredElement("results");
const copyButton = requiredElement("copy-results");
const canvas = requiredElement("glyph-canvas") as HTMLCanvasElement;
const monacoHost = requiredElement("monaco");

let allFiles: readonly DatasetFile[] = [];
let renderer: RendererState | null = null;
let latestResults: readonly MeasurementResult[] = [];
let activeMeasurement = false;

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element;
}

const datasetModules = import.meta.glob<string>(
  "/fixtures/reference-dataset/**/*.{ts,tsx}",
  { import: "default", query: "?raw" },
);

async function loadDataset(): Promise<DatasetFile[]> {
  const entries = Object.entries(datasetModules).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    throw new Error("Reference Dataset glob returned no files");
  }
  return Promise.all(
    entries.map(async ([relativePath, load]) => {
      const text = await load();
      return { relativePath, text, lines: text.split("\n") };
    }),
  );
}

function createRasterCanvas(): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE);
  }
  const element = document.createElement("canvas");
  element.width = ATLAS_SIZE;
  element.height = ATLAS_SIZE;
  return element;
}

function rasterContext(
  canvasElement: HTMLCanvasElement | OffscreenCanvas,
): RasterContext {
  const context = canvasElement.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas2D is unavailable for glyph rasterization");
  }
  return context;
}

function collectGlyphs(files: readonly DatasetFile[]): string[] {
  const glyphs = new Set<string>([" ", "□"]);
  for (const file of files) {
    for (const line of file.lines) {
      for (let offset = 0; offset < line.length;) {
        const codePoint = line.codePointAt(offset);
        if (codePoint === undefined) {
          break;
        }
        glyphs.add(String.fromCodePoint(codePoint));
        offset += String.fromCodePoint(codePoint).length;
        if (glyphs.size >= MAX_ATLAS_SLOTS) {
          return [...glyphs];
        }
      }
    }
  }
  return [...glyphs];
}

function buildAtlas(files: readonly DatasetFile[]): AtlasData {
  const rasterCanvas = createRasterCanvas();
  const context = rasterContext(rasterCanvas);
  context.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  context.fillStyle = "white";
  context.font = `${String(FONT_SIZE * RASTER_SCALE)}px ${FONT_FAMILY}, monospace`;
  context.textBaseline = "alphabetic";
  const slots = new Map<string, number>();
  for (const glyph of collectGlyphs(files)) {
    const slot = slots.size;
    if (slot >= MAX_ATLAS_SLOTS) {
      break;
    }
    slots.set(glyph, slot);
    const x = (slot % ATLAS_COLUMNS) * ATLAS_CELL_SIZE + 4 * RASTER_SCALE;
    const y =
      Math.floor(slot / ATLAS_COLUMNS) * ATLAS_CELL_SIZE + 21 * RASTER_SCALE;
    context.fillText(glyph, x, y);
  }
  const pixels = context.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE).data;
  const bytes = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = pixels[index * 4 + 3] ?? 0;
  }
  return { bytes, slots, cellSize: ATLAS_CELL_SIZE, columns: ATLAS_COLUMNS };
}

function shader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const compiled = gl.createShader(type);
  if (!compiled) {
    throw new Error("Unable to create WebGL shader");
  }
  gl.shaderSource(compiled, source);
  gl.compileShader(compiled);
  if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(compiled) ?? "unknown shader error";
    logShaderFailure("compile", source, message);
    gl.deleteShader(compiled);
    throw new Error(message);
  }
  return compiled;
}

function logShaderFailure(
  stage: "compile" | "link",
  source: string,
  message: string,
): void {
  for (const line of message.split("\n")) {
    console.error(`PAGE: shader ${stage} info log: ${line}`);
  }
  const lineMatch = /:(\d+):/.exec(message);
  const reportedLine = Number(lineMatch?.[1] ?? 0);
  for (const [index, line] of source.split("\n").entries()) {
    const lineNumber = index + 1;
    const marker = lineNumber === reportedLine ? " <--- reported" : "";
    console.error(
      `PAGE: shader ${stage} source ${String(lineNumber).padStart(3, "0")}${marker}: ${line}`,
    );
  }
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertexSource = `#version 300 es
      layout(location = 0) in vec2 aCorner;
      layout(location = 1) in uint aWidgetIndex;
      layout(location = 2) in uint aRow;
      layout(location = 3) in uint aColumn;
      layout(location = 4) in uint aAtlasSlot;
      layout(location = 5) in uint aColorIndex;
      uniform sampler2D uWidgetTable;
      uniform vec2 uViewport;
      uniform vec2 uCamera;
      uniform float uDpr;
      uniform float uAdvance;
      uniform float uLineHeight;
      uniform float uAtlasColumns;
      uniform float uAtlasCellSize;
      uniform vec2 uAtlasRegion;
      out vec2 vAtlasUv;
      out vec2 vWorldPosition;
      flat out vec4 vWidgetFrame;
      flat out uint vColorIndex;
      void main() {
        vec4 widget = texelFetch(uWidgetTable, ivec2(int(aWidgetIndex), 0), 0);
        float worldX = widget.x + 12.0 + float(aColumn) * uAdvance;
        float worldY = widget.y + 22.0 + float(aRow) * uLineHeight;
        vec2 world = vec2(worldX, worldY) + aCorner * vec2(uAdvance, uLineHeight);
        vec2 screen = (world - uCamera) * uDpr;
        vec2 clip = vec2(screen.x / uViewport.x, screen.y / uViewport.y);
        gl_Position = vec4(vec2(clip.x * 2.0 - 1.0, 1.0 - clip.y * 2.0), float(aWidgetIndex + 1u) / 200.0, 1.0);
        float slot = float(aAtlasSlot);
        vec2 atlasOrigin = vec2(mod(slot, uAtlasColumns), floor(slot / uAtlasColumns)) * uAtlasCellSize;
        vAtlasUv = (atlasOrigin + aCorner * uAtlasRegion) / (uAtlasCellSize * vec2(uAtlasColumns, 16.0));
        vWorldPosition = world;
        vWidgetFrame = widget;
        vColorIndex = aColorIndex;
      }`;
  const fragmentSource = `#version 300 es
      precision highp float;
      precision highp int;
      uniform sampler2D uAtlas;
      uniform vec4 uPalette[8];
      in vec2 vAtlasUv;
      in vec2 vWorldPosition;
      flat in vec4 vWidgetFrame;
      flat in uint vColorIndex;
      out vec4 outColor;
      void main() {
        float bodyTop = vWidgetFrame.y + 28.0;
        float bodyBottom = vWidgetFrame.y + vWidgetFrame.w;
        if (vWorldPosition.x < vWidgetFrame.x || vWorldPosition.x > vWidgetFrame.x + vWidgetFrame.z ||
            vWorldPosition.y < bodyTop || vWorldPosition.y > bodyBottom) {
          discard;
        }
        float alpha = texture(uAtlas, vAtlasUv).r;
        if (alpha < 0.01) {
          discard;
        }
        outColor = vec4(uPalette[int(vColorIndex % 8u)].rgb, alpha);
      }`;
  const vertex = shader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "unknown program error";
    logShaderFailure("link", vertexSource, message);
    logShaderFailure("link", fragmentSource, message);
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function uniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) {
    throw new Error(`Missing shader uniform ${name}`);
  }
  return location;
}

function setupRenderer(files: readonly DatasetFile[]): RendererState {
  const context = canvas.getContext("webgl2", {
    antialias: false,
    depth: true,
  });
  if (!context) {
    throw new Error("WebGL2 is unavailable");
  }
  const gl = context;
  const atlas = buildAtlas(files);
  const program = createProgram(gl);
  const vao = gl.createVertexArray();
  const quadBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();
  const widgetTexture = gl.createTexture();
  const atlasTexture = gl.createTexture();
  gl.useProgram(program);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(
    gl.ELEMENT_ARRAY_BUFFER,
    new Uint16Array([0, 1, 2, 0, 2, 3]),
    gl.STATIC_DRAW,
  );
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  for (let index = 0; index < 5; index += 1) {
    const location = index + 1;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribIPointer(location, 1, gl.UNSIGNED_INT, 20, index * 4);
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindVertexArray(null);
  uploadAtlas(gl, atlasTexture, atlas);
  uploadWidgetTable(gl, widgetTexture);
  gl.useProgram(program);
  const uniforms: RendererUniforms = {
    viewport: uniform(gl, program, "uViewport"),
    camera: uniform(gl, program, "uCamera"),
    dpr: uniform(gl, program, "uDpr"),
    advance: uniform(gl, program, "uAdvance"),
    lineHeight: uniform(gl, program, "uLineHeight"),
    atlas: uniform(gl, program, "uAtlas"),
    atlasColumns: uniform(gl, program, "uAtlasColumns"),
    atlasCellSize: uniform(gl, program, "uAtlasCellSize"),
    atlasRegion: uniform(gl, program, "uAtlasRegion"),
    widgetTable: uniform(gl, program, "uWidgetTable"),
    palette: uniform(gl, program, "uPalette"),
  };
  const timer = gl.getExtension(
    "EXT_disjoint_timer_query_webgl2",
  ) as TimerQueryExtension | null;
  const queries = Array.from({ length: QUERY_RING_SIZE }, () =>
    gl.createQuery(),
  );
  const queryConsumed = Array.from({ length: QUERY_RING_SIZE }, () => false);
  const metricsContext = rasterContext(createRasterCanvas());
  metricsContext.font = `${String(FONT_SIZE)}px ${FONT_FAMILY}, monospace`;
  const metrics = metricsContext.measureText("M");
  const queryTarget = timer?.TIME_ELAPSED_EXT ?? 0;
  return {
    canvas,
    gl,
    program,
    vao,
    instanceBuffer,
    widgetTexture,
    atlasTexture,
    atlas,
    advance: metrics.width / RASTER_SCALE,
    queryExtension: timer,
    queries,
    queryConsumed,
    queryTarget,
    queryResult: gl.QUERY_RESULT,
    queryAvailable: gl.QUERY_RESULT_AVAILABLE,
    uniform: uniforms,
    instanceCount: 0,
    queryCursor: 0,
  };
}

function uploadAtlas(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  atlas: AtlasData,
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    ATLAS_SIZE,
    ATLAS_SIZE,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    atlas.bytes,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function uploadWidgetTable(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
): void {
  const table = new Float32Array(FILE_COUNT * 4);
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const column = index % 10;
    const row = Math.floor(index / 10);
    const offset = index * 4;
    table[offset] = column * 520;
    table[offset + 1] = row * 430;
    table[offset + 2] = 500;
    table[offset + 3] = 340;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    FILE_COUNT,
    1,
    0,
    gl.RGBA,
    gl.FLOAT,
    table,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function uploadInstances(
  state: RendererState,
  files: readonly DatasetFile[],
  glyphCount: number,
): void {
  const records = new Uint32Array(glyphCount * 5);
  const fallback = state.atlas.slots.get("□") ?? 0;
  let fileIndex = 0;
  let lineIndex = 0;
  let offset = 0;
  let expandedColumn = 0;
  let pendingTabSpaces = 0;
  for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex += 1) {
    const file = files[fileIndex] ?? files[0];
    const line = file?.lines[lineIndex] ?? "";
    if (pendingTabSpaces === 0 && offset >= line.length) {
      offset = 0;
      expandedColumn = 0;
      lineIndex += 1;
      if (lineIndex >= (file?.lines.length ?? 1) - 1) {
        lineIndex = 0;
        fileIndex = (fileIndex + 1) % files.length;
      }
    }
    const currentFile = files[fileIndex] ?? files[0];
    const currentLine = currentFile?.lines[lineIndex] ?? "";
    let codePoint = 0x20;
    let glyph = " ";
    if (pendingTabSpaces > 0) {
      pendingTabSpaces -= 1;
    } else {
      codePoint = currentLine.codePointAt(offset) ?? 0xfffd;
      glyph = String.fromCodePoint(codePoint);
      offset += glyph.length;
      if (glyph === "\t") {
        codePoint = 0x20;
        glyph = " ";
        pendingTabSpaces = TAB_SIZE - 1;
      }
    }
    const slot = state.atlas.slots.get(glyph) ?? fallback;
    const recordOffset = glyphIndex * 5;
    records[recordOffset] = fileIndex;
    records[recordOffset + 1] = lineIndex;
    records[recordOffset + 2] = expandedColumn;
    records[recordOffset + 3] = slot;
    records[recordOffset + 4] = codePoint % 8;
    expandedColumn += 1;
  }
  state.gl.bindBuffer(state.gl.ARRAY_BUFFER, state.instanceBuffer);
  state.gl.bufferData(state.gl.ARRAY_BUFFER, records, state.gl.STREAM_DRAW);
  state.gl.bindBuffer(state.gl.ARRAY_BUFFER, null);
  state.instanceCount = glyphCount;
}

function resizeCanvas(state: RendererState): void {
  const dpr = window.devicePixelRatio;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === width && canvas.height === height) {
    return;
  }
  canvas.width = width;
  canvas.height = height;
  state.gl.viewport(0, 0, width, height);
}

function beginTimer(state: RendererState): void {
  if (!state.queryExtension) {
    return;
  }
  const query = state.queries[state.queryCursor];
  if (!query) {
    return;
  }
  state.queryConsumed[state.queryCursor] = false;
  state.gl.beginQuery(state.queryTarget, query);
}

function finishTimer(state: RendererState): void {
  if (!state.queryExtension) {
    return;
  }
  state.gl.endQuery(state.queryTarget);
  state.queryCursor = (state.queryCursor + 1) % QUERY_RING_SIZE;
}

function readTimerResults(
  state: RendererState,
  target: Float64Array,
  count: number,
): number {
  if (!state.queryExtension) {
    return count;
  }
  const disjoint = state.gl.getParameter(
    state.queryExtension.GPU_DISJOINT_EXT,
  ) as boolean;
  if (disjoint) {
    return count;
  }
  for (let index = 0; index < state.queries.length; index += 1) {
    const query = state.queries[index];
    if (!query || state.queryConsumed[index] || count >= target.length) {
      continue;
    }
    const available = state.gl.getQueryParameter(
      query,
      state.queryAvailable,
    ) as boolean;
    if (!available) {
      continue;
    }
    const nanoseconds = state.gl.getQueryParameter(
      query,
      state.queryResult,
    ) as number;
    target[count] = nanoseconds / 1_000_000;
    count += 1;
    state.queryConsumed[index] = true;
  }
  return count;
}

function drawFrame(
  state: RendererState,
  timestamp: number,
  startedAt: number,
  durationMs: number,
): void {
  resizeCanvas(state);
  const elapsed = timestamp - startedAt;
  const travel = Math.min(1, elapsed / durationMs) * 2600;
  const cameraX = travel + Math.sin(elapsed / 500) * 90;
  const cameraY = Math.cos(elapsed / 700) * 120;
  const gl = state.gl;
  gl.useProgram(state.program);
  gl.bindVertexArray(state.vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.atlasTexture);
  gl.uniform1i(state.uniform.atlas, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, state.widgetTexture);
  gl.uniform1i(state.uniform.widgetTable, 1);
  gl.uniform2f(state.uniform.viewport, canvas.width, canvas.height);
  gl.uniform2f(state.uniform.camera, cameraX, cameraY);
  gl.uniform1f(state.uniform.dpr, window.devicePixelRatio);
  gl.uniform1f(state.uniform.advance, state.advance);
  gl.uniform1f(state.uniform.lineHeight, LINE_HEIGHT);
  gl.uniform1f(state.uniform.atlasColumns, state.atlas.columns);
  gl.uniform1f(state.uniform.atlasCellSize, state.atlas.cellSize);
  gl.uniform2f(
    state.uniform.atlasRegion,
    ATLAS_GLYPH_WIDTH,
    ATLAS_GLYPH_HEIGHT,
  );
  gl.uniform4fv(state.uniform.palette, PALETTE);
  gl.clearColor(0.067, 0.082, 0.11, 1);
  gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(false);
  beginTimer(state);
  gl.drawElementsInstanced(
    gl.TRIANGLES,
    6,
    gl.UNSIGNED_SHORT,
    0,
    state.instanceCount,
  );
  finishTimer(state);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindVertexArray(null);
}

function summarize(values: Float64Array, count: number): MetricSummary {
  const sorted = Array.from(values.subarray(0, count)).sort(
    (left, right) => left - right,
  );
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0;
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function createMeasurement(
  state: RendererState,
  glyphCount: number,
  durationMs: number,
): Promise<MeasurementResult> {
  if (activeMeasurement) {
    return Promise.reject(new Error("A measurement is already running"));
  }
  activeMeasurement = true;
  uploadInstances(state, allFiles, glyphCount);
  const cpu = new Float64Array(MAX_RECORDED_FRAMES);
  const intervals = new Float64Array(MAX_RECORDED_FRAMES);
  const gpu = new Float64Array(MAX_RECORDED_FRAMES);
  let frameCount = 0;
  let gpuCount = 0;
  let startedAt = -1;
  let previousTimestamp = -1;
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      window.setTimeout(() => {
        gpuCount = readTimerResults(state, gpu, gpuCount);
        activeMeasurement = false;
        const intervalCount = Math.max(0, frameCount - 1);
        const result: MeasurementResult = {
          glyphCount,
          durationMs,
          frameCount,
          drawCalls: 1,
          devicePixelRatio: window.devicePixelRatio,
          cpuFrameMs: summarize(cpu, frameCount),
          rafIntervalMs: summarize(intervals, intervalCount),
          rafIntervals: Array.from(intervals.subarray(0, intervalCount)),
          gpuFrameMs: state.queryExtension
            ? summarize(gpu, gpuCount)
            : "unavailable",
          gpuTimerQuery: state.queryExtension
            ? "EXT_disjoint_timer_query_webgl2"
            : "unavailable",
        };
        latestResults = [...latestResults, result];
        renderResults();
        resolve(result);
      }, 100);
    };
    const frame = (timestamp: number): void => {
      if (startedAt < 0) {
        startedAt = timestamp;
      }
      if (previousTimestamp >= 0 && frameCount < intervals.length) {
        intervals[frameCount - 1] = timestamp - previousTimestamp;
      }
      previousTimestamp = timestamp;
      const start = performance.now();
      drawFrame(state, timestamp, startedAt, durationMs);
      if (frameCount < cpu.length) {
        cpu[frameCount] = performance.now() - start;
        frameCount += 1;
      }
      gpuCount = readTimerResults(state, gpu, gpuCount);
      if (timestamp - startedAt < durationMs) {
        window.requestAnimationFrame(frame);
        return;
      }
      finish();
    };
    try {
      window.requestAnimationFrame(frame);
    } catch (error) {
      activeMeasurement = false;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function createMonacoCrossCheck(
  files: readonly DatasetFile[],
): MonacoCrossCheck {
  const model = monaco.editor.createModel(
    files[0]?.lines.slice(0, 120).join("\n") ?? "",
    "plaintext",
  );
  const monacoInstance = monaco.editor.create(monacoHost, {
    model,
    automaticLayout: false,
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    fontLigatures: false,
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    wordWrap: "off",
    readOnly: true,
    scrollBeyondLastLine: false,
    renderWhitespace: "none",
  });
  monacoInstance.layout({ width: 430, height: 230 });
  monacoInstance.render(true);
  const fontInfo = monacoInstance.getOption(
    monaco.editor.EditorOption.fontInfo,
  );
  const metricsCanvas = createRasterCanvas();
  const metrics = rasterContext(metricsCanvas);
  metrics.font = `${String(FONT_SIZE)}px ${FONT_FAMILY}, monospace`;
  const advance = metrics.measureText("M").width;
  const sampleLine = Math.min(4, model.getLineCount());
  const sampleText = model.getLineContent(sampleLine);
  const firstPosition = monacoInstance.getScrolledVisiblePosition({
    lineNumber: sampleLine,
    column: 1,
  });
  let maxXDeviation = 0;
  let expandedColumn = 0;
  for (let offset = 0; offset < sampleText.length;) {
    const codePoint = sampleText.codePointAt(offset);
    if (codePoint === undefined) {
      break;
    }
    const position = monacoInstance.getScrolledVisiblePosition({
      lineNumber: sampleLine,
      column: offset + 1,
    });
    if (position && firstPosition) {
      maxXDeviation = Math.max(
        maxXDeviation,
        Math.abs(position.left - firstPosition.left - expandedColumn * advance),
      );
    }
    const glyph = String.fromCodePoint(codePoint);
    offset += glyph.length;
    expandedColumn += glyph === "\t" ? TAB_SIZE : 1;
  }
  const fontMetrics = metrics.measureText("Mg");
  const baselineOffset =
    (fontInfo.lineHeight -
      fontMetrics.actualBoundingBoxAscent -
      fontMetrics.actualBoundingBoxDescent) /
      2 +
    fontMetrics.actualBoundingBoxAscent;
  let maxBaselineDeviation = 0;
  for (
    let lineNumber = 1;
    lineNumber <= Math.min(8, model.getLineCount());
    lineNumber += 1
  ) {
    const top = monacoInstance.getTopForLineNumber(lineNumber);
    const monacoBaseline = top + baselineOffset;
    const expectedBaseline = (lineNumber - 1) * LINE_HEIGHT + baselineOffset;
    maxBaselineDeviation = Math.max(
      maxBaselineDeviation,
      Math.abs(monacoBaseline - expectedBaseline),
    );
  }
  return {
    fontFamily: fontInfo.fontFamily,
    fontSizeCssPx: fontInfo.fontSize,
    lineHeightCssPx: fontInfo.lineHeight,
    maxGlyphXDeviationCssPx: maxXDeviation,
    maxBaselineDeviationCssPx: maxBaselineDeviation,
    sampledLine: sampleLine,
    sampledText: sampleText.slice(0, 120),
  };
}

function renderResults(): void {
  resultsElement.textContent = JSON.stringify(
    {
      font: FONT_FAMILY,
      rasterScale: RASTER_SCALE,
      atlas: {
        internalFormat: "R8",
        size: ATLAS_SIZE,
        slots: renderer?.atlas.slots.size ?? 0,
      },
      monacoCrossCheck: (window as SpikeWindow).spikeB?.monacoCrossCheck,
      datasetSourceCheck: (window as SpikeWindow).spikeB?.datasetSourceCheck,
      measurements: latestResults,
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

async function initialize(): Promise<void> {
  try {
    allFiles = await loadDataset();
    const firstFile = allFiles[0];
    if (!firstFile) {
      throw new Error("Reference Dataset has no files");
    }
    renderer = setupRenderer(allFiles);
    const monacoCrossCheck = createMonacoCrossCheck(allFiles);
    const datasetSourceCheck: DatasetSourceCheck = {
      relativePath: firstFile.relativePath,
      length: firstFile.text.length,
      prefix: firstFile.text.slice(0, 128),
    };
    const api: SpikeApi = {
      measure: (glyphCount, durationMs) => {
        if (!renderer) {
          return Promise.reject(new Error("Renderer is not ready"));
        }
        return createMeasurement(renderer, glyphCount, durationMs);
      },
      monacoCrossCheck,
      datasetSourceCheck,
    };
    (window as SpikeWindow).spikeB = api;
    statusElement.textContent = `Dataset ready: ${String(allFiles.length)} files × 2000 lines. WebGL2 is ready.`;
    renderResults();
  } catch (error) {
    statusElement.textContent = `Spike setup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

void initialize();
