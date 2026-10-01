import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  LineLayout,
  type LayoutCell,
} from "../../src/code-view/domain/line-layout";
import { createTextMetrics } from "../../src/rendering/text/text-metrics";
import {
  createAtlasTexture,
  drawRasterCells,
  rasterizeAtlas,
  TEXT_FRAGMENT,
  TEXT_VERTEX,
  type AlphaMode,
  type AtlasKind,
  type AtlasRecord,
} from "./renderer";

const REFERENCE_PATH = "fixtures/reference-dataset/group-00/widget-000.tsx";
const ZOOMS = [0.75, 1, 1.37, 2] as const;
const REGION_WIDTH = 360;
const REGION_HEIGHT = 140;
const LINE_COUNT = 40;
const BACKGROUND = "#181e28";
const COLORS = ["#d9e1ee", "#8ee0a4", "#e8c98e"] as const;
const FALLBACK_TEXT = `const glyphRecord: Record<string, number> = { punctuation: 42, id: 7 }; // Привет 東京 🧭
const view = <article data-id={42} aria-label="text sharpness"><span>{unicodeText}</span></article>;
/* multiline comment: colors and spacing must remain readable */
const template = \`value=\${fixtureId}: Привет 東京 🧭\`;`;

const rawReferenceFiles = import.meta.glob<string>(
  "/fixtures/reference-dataset/group-00/widget-000.tsx",
  { eager: true, import: "default", query: "?raw" },
);

type VariantName =
  | "dom"
  | "atlas-exact"
  | "atlas-phased"
  | "atlas-discrete"
  | "canvas"
  | "canvas-stale";
interface AtlasData {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly memoryBytes: number;
  readonly buildMs: number;
  readonly rasterMs: number;
  readonly uploadMs: number;
  readonly records: Map<string, readonly AtlasRecord[]>;
  readonly phased: boolean;
  readonly alphaMode: AlphaMode;
}

interface CanvasCost {
  readonly rasterMs: number;
  readonly uploadMs: number;
  readonly textureBytes: number;
}

interface AtlasCost {
  readonly buildMs: number;
  readonly rasterMs: number;
  readonly uploadMs: number;
  readonly textureBytes: number;
}

interface SpikeState {
  readonly ready: boolean;
  readonly datasetAvailable: boolean;
  readonly sourcePath: string;
  readonly sourceTextLength: number;
  readonly sourceTextPrefix: string;
  readonly devicePixelRatio: number;
  readonly font: typeof DEFAULT_CODE_FONT;
  readonly lineCount: number;
  readonly zooms: readonly number[];
}

interface SpikeApi {
  readonly getState: () => SpikeState;
  readonly setZoom: (zoom: number) => void;
  readonly setAlphaMode: (mode: AlphaMode) => void;
  readonly measureCosts: () => {
    readonly canvas: {
      readonly fortyLines: CanvasCost[];
      readonly twoThousandLines: CanvasCost[];
    };
    readonly atlas: {
      readonly exact: AtlasCost[];
      readonly phased: AtlasCost[];
    };
  };
}

declare global {
  interface Window {
    __spikeH?: SpikeApi;
  }
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Spike H is missing ${label}`);
  return value;
}

function setCanvasSize(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function shader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const result = gl.createShader(type);
  if (!result) throw new Error("Spike H could not create a WebGL shader");
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(result) ?? "unknown shader error";
    throw new Error(`Spike H shader failed: ${log}`);
  }
  return result;
}

function program(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const result = gl.createProgram();
  gl.attachShader(result, shader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(result, shader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
    throw new Error(
      `Spike H program failed: ${gl.getProgramInfoLog(result) ?? "unknown link error"}`,
    );
  }
  return result;
}

const IMAGE_VERTEX = `#version 300 es
in vec2 position;
uniform vec2 resolution;
uniform vec2 size;
out vec2 uv;
void main() {
  vec2 pixel = position * size;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  uv = position;
}`;

const IMAGE_FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D source;
in vec2 uv;
out vec4 color;
void main() { color = texture(source, uv); }`;

class WebGlRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly textProgram: WebGLProgram;
  private readonly imageProgram: WebGLProgram;
  private readonly textBuffer: WebGLBuffer;
  private readonly imageBuffer: WebGLBuffer;
  private readonly imageTexture: WebGLTexture;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    setCanvasSize(canvas, REGION_WIDTH * dpr, REGION_HEIGHT * dpr);
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) throw new Error("WebGL2 is unavailable");
    this.gl = gl;
    this.textProgram = program(gl, TEXT_VERTEX, TEXT_FRAGMENT);
    this.imageProgram = program(gl, IMAGE_VERTEX, IMAGE_FRAGMENT);
    this.textBuffer = required(gl.createBuffer(), "the text buffer");
    this.imageBuffer = required(gl.createBuffer(), "the image buffer");
    this.imageTexture = required(gl.createTexture(), "the image texture");
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  uploadCanvas(source: HTMLCanvasElement): number {
    const start = performance.now();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return performance.now() - start;
  }

  drawImage(source: HTMLCanvasElement, zoom: number): void {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.094, 0.118, 0.157, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.imageProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.imageBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(this.imageProgram, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(
      gl.getUniformLocation(this.imageProgram, "resolution"),
      width,
      height,
    );
    gl.uniform2f(
      gl.getUniformLocation(this.imageProgram, "size"),
      source.width * zoom,
      source.height * zoom,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(gl.getUniformLocation(this.imageProgram, "source"), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  drawAtlas(
    atlas: AtlasData,
    layouts: readonly LineLayout[],
    zoom: number,
    metricsBaseline: number,
    lineHeight: number,
    alphaMode: AlphaMode,
  ): void {
    const dpr = window.devicePixelRatio || 1;
    const vertices: number[] = [];
    layouts.forEach((layout, lineIndex) => {
      const [red, green, blue] = colorRgbForLine(lineIndex);
      for (const cell of layout.cells(0)) {
        const choices = atlas.records.get(cell.text) ?? [];
        const deviceX = cell.x * zoom * dpr;
        const phaseIndex = atlas.phased
          ? Math.round((deviceX - Math.floor(deviceX)) * 4) % 4
          : 0;
        const record = choices[phaseIndex] ?? choices[0];
        if (!record) continue;
        const scale = record.sourceScale;
        const x = deviceX - record.padding * scale;
        const y =
          (lineIndex * lineHeight + metricsBaseline) * zoom * dpr -
          (record.padding + record.baseline) * scale;
        const w = record.drawWidth * scale;
        const h = record.drawHeight * scale;
        const u0 = record.uvX / atlas.width;
        const v0 = record.uvY / atlas.height;
        const u1 = (record.uvX + record.uvWidth) / atlas.width;
        const v1 = (record.uvY + record.uvHeight) / atlas.height;
        const addVertex = (
          vertexX: number,
          vertexY: number,
          vertexU: number,
          vertexV: number,
        ): void => {
          vertices.push(vertexX, vertexY, vertexU, vertexV, red, green, blue);
        };
        addVertex(x, y, u0, v0);
        addVertex(x + w, y, u1, v0);
        addVertex(x, y + h, u0, v1);
        addVertex(x + w, y, u1, v0);
        addVertex(x + w, y + h, u1, v1);
        addVertex(x, y + h, u0, v1);
      }
    });
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.094, 0.118, 0.157, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.textProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.textBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
    const positionUv = gl.getAttribLocation(this.textProgram, "positionUv");
    gl.enableVertexAttribArray(positionUv);
    gl.vertexAttribPointer(positionUv, 4, gl.FLOAT, false, 28, 0);
    const colorIn = gl.getAttribLocation(this.textProgram, "colorIn");
    gl.enableVertexAttribArray(colorIn);
    gl.vertexAttribPointer(colorIn, 3, gl.FLOAT, false, 28, 16);
    gl.uniform2f(
      gl.getUniformLocation(this.textProgram, "resolution"),
      this.canvas.width,
      this.canvas.height,
    );
    gl.uniform4f(gl.getUniformLocation(this.textProgram, "camera"), 0, 0, 1, 1);
    gl.uniform1i(
      gl.getUniformLocation(this.textProgram, "straightTexture"),
      alphaMode === "straight" ? 1 : 0,
    );
    gl.uniform1i(
      gl.getUniformLocation(this.textProgram, "premultiplied"),
      alphaMode === "premultiplied" ? 1 : 0,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
    gl.uniform1i(gl.getUniformLocation(this.textProgram, "atlas"), 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(
      alphaMode === "premultiplied" ? gl.ONE : gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 7);
    gl.disable(gl.BLEND);
  }

  createAtlasTexture(
    width: number,
    height: number,
    pixels: Uint8Array,
    alphaMode: AlphaMode,
  ): WebGLTexture {
    return createAtlasTexture(this.gl, { width, height, pixels }, alphaMode);
  }
}

function colorsForLine(lineIndex: number): string {
  return COLORS[lineIndex % COLORS.length] ?? COLORS[0];
}

const COLOR_RGB = [
  [0.851, 0.882, 0.933],
  [0.557, 0.878, 0.643],
  [0.91, 0.788, 0.557],
] as const;

function colorRgbForLine(lineIndex: number): readonly [number, number, number] {
  return COLOR_RGB[lineIndex % COLOR_RGB.length] ?? COLOR_RGB[0];
}

function createLayouts(
  lines: readonly string[],
  metrics: ReturnType<typeof createTextMetrics>,
): LineLayout[] {
  return lines.map((line) => new LineLayout(line, metrics));
}

function createDomLayer(
  lines: readonly string[],
  layouts: readonly LineLayout[],
  metrics: ReturnType<typeof createTextMetrics>,
): HTMLDivElement {
  const layer = document.createElement("div");
  layer.className = "dom-layer";
  layer.style.setProperty("--font-family", DEFAULT_CODE_FONT.family);
  layer.style.setProperty("--font-size", `${String(DEFAULT_CODE_FONT.size)}px`);
  layer.style.setProperty(
    "--line-height",
    `${String(DEFAULT_CODE_FONT.lineHeight)}px`,
  );
  layer.style.setProperty(
    "--font-features",
    DEFAULT_CODE_FONT.fontFeatureSettings,
  );
  lines.forEach((_line, index) => {
    const element = document.createElement("div");
    element.className = "dom-line";
    element.style.top = `${String(index * metrics.lineHeight)}px`;
    element.style.color = colorsForLine(index);
    for (const cell of layouts[index]?.cells(0) ?? []) {
      const cluster = document.createElement("span");
      cluster.className = "dom-cluster";
      cluster.style.left = `${String(cell.x)}px`;
      cluster.textContent = cell.text;
      element.append(cluster);
    }
    layer.append(element);
  });
  return layer;
}

function rasterizeCanvas(
  lines: readonly string[],
  layouts: readonly LineLayout[],
  metrics: ReturnType<typeof createTextMetrics>,
  zoom: number,
): HTMLCanvasElement {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  setCanvasSize(
    canvas,
    Math.ceil(REGION_WIDTH * dpr),
    Math.ceil(lines.length * metrics.lineHeight * zoom * dpr),
  );
  const context = required(canvas.getContext("2d"), "a Canvas2D context");
  context.scale(dpr, dpr);
  context.fillStyle = BACKGROUND;
  context.fillRect(
    0,
    0,
    REGION_WIDTH,
    lines.length * metrics.lineHeight * zoom,
  );
  drawRasterCells(
    context,
    layouts.flatMap((layout, lineIndex) =>
      layout.cells(0).map((cell) => ({
        text: cell.text,
        x: cell.x * zoom,
        y: (lineIndex * metrics.lineHeight + metrics.baseline) * zoom,
        color: colorsForLine(lineIndex),
      })),
    ),
    `${String(DEFAULT_CODE_FONT.size * zoom)}px ${DEFAULT_CODE_FONT.family}`,
  );
  return canvas;
}

function atlasRecords(
  layouts: readonly LineLayout[],
  metrics: ReturnType<typeof createTextMetrics>,
  zoom: number,
  kind: AtlasKind,
  renderer: WebGlRenderer,
  alphaMode: AlphaMode,
): AtlasData {
  const dpr = window.devicePixelRatio || 1;
  const raster = rasterizeAtlas(
    [{ cells: layouts.map((layout) => layout.cells(0)) }],
    metrics,
    zoom,
    kind,
    dpr,
    alphaMode,
  );
  const uploadStart = performance.now();
  const texture = renderer.createAtlasTexture(
    raster.width,
    raster.height,
    raster.pixels,
    alphaMode,
  );
  const uploadMs = performance.now() - uploadStart;
  return {
    texture,
    width: raster.width,
    height: raster.height,
    memoryBytes: raster.memoryBytes,
    buildMs: raster.rasterMs + uploadMs,
    rasterMs: raster.rasterMs,
    uploadMs,
    records: raster.records,
    phased: raster.phased,
    alphaMode,
  };
}

function addStage(container: HTMLElement, name: string): HTMLElement {
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = name;
  const viewport = document.createElement("div");
  viewport.className = "viewport";
  viewport.dataset.variant = name;
  figure.append(caption, viewport);
  container.append(figure);
  return viewport;
}

function lineCells(layout: LineLayout): readonly LayoutCell[] {
  return layout.cells(0);
}

function renderCanvasVariant(
  canvas: HTMLCanvasElement,
  lines: readonly string[],
  layouts: readonly LineLayout[],
  metrics: ReturnType<typeof createTextMetrics>,
  zoom: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  setCanvasSize(canvas, REGION_WIDTH * dpr, REGION_HEIGHT * dpr);
  const context = required(
    canvas.getContext("2d"),
    "the visible Canvas2D context",
  );
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, REGION_WIDTH, REGION_HEIGHT);
  context.textBaseline = "alphabetic";
  context.font = `${String(DEFAULT_CODE_FONT.size * zoom)}px ${DEFAULT_CODE_FONT.family}`;
  lines.forEach((_line, lineIndex) => {
    const cells = lineCells(layouts[lineIndex] ?? new LineLayout("", metrics));
    context.fillStyle = colorsForLine(lineIndex);
    for (const cell of cells)
      context.fillText(
        cell.text,
        cell.x * zoom,
        (lineIndex * metrics.lineHeight + metrics.baseline) * zoom,
      );
  });
}

function buildSpike(): void {
  const readyState = required(
    document.querySelector<HTMLElement>("#ready-state"),
    "the ready state",
  );
  const status = required(
    document.querySelector<HTMLElement>("#status"),
    "the status",
  );
  const variants = required(
    document.querySelector<HTMLElement>("#variants"),
    "the variants container",
  );
  const sourceText =
    rawReferenceFiles["/fixtures/reference-dataset/group-00/widget-000.tsx"] ??
    FALLBACK_TEXT;
  const datasetAvailable = sourceText !== FALLBACK_TEXT;
  const lines = sourceText.split("\n").slice(0, LINE_COUNT);
  while (lines.length < LINE_COUNT) lines.push("");
  const metrics = createTextMetrics(DEFAULT_CODE_FONT);
  const layouts = createLayouts(lines, metrics);
  const stages = new Map<VariantName, HTMLElement>();
  stages.set("dom", addStage(variants, "DOM"));
  stages.set("atlas-exact", addStage(variants, "Atlas, exact size"));
  stages.set("atlas-phased", addStage(variants, "Atlas, exact size + phases"));
  stages.set("atlas-discrete", addStage(variants, "Atlas, discrete set"));
  stages.set("canvas", addStage(variants, "Canvas2D raster"));
  stages.set(
    "canvas-stale",
    addStage(variants, "Canvas2D, stale during gesture"),
  );
  const domLayer = createDomLayer(lines, layouts, metrics);
  stages.get("dom")?.append(domLayer);
  const atlasCanvases = new Map<VariantName, HTMLCanvasElement>();
  const renderers = new Map<VariantName, WebGlRenderer>();
  (
    ["atlas-exact", "atlas-phased", "atlas-discrete", "canvas-stale"] as const
  ).forEach((variant) => {
    const canvas = document.createElement("canvas");
    stages.get(variant)?.append(canvas);
    atlasCanvases.set(variant, canvas);
    try {
      renderers.set(variant, new WebGlRenderer(canvas));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      canvas.replaceWith(
        Object.assign(document.createElement("div"), {
          className: "webgl-error",
          textContent: message,
        }),
      );
    }
  });
  const canvasRaster = document.createElement("canvas");
  stages.get("canvas")?.append(canvasRaster);
  const staleSource = rasterizeCanvas(lines, layouts, metrics, 1);
  const state: SpikeState = {
    ready: datasetAvailable,
    datasetAvailable,
    sourcePath: datasetAvailable
      ? REFERENCE_PATH
      : "fallback sample — run pnpm fixtures first",
    sourceTextLength: sourceText.length,
    sourceTextPrefix: sourceText.slice(0, 120),
    devicePixelRatio: window.devicePixelRatio || 1,
    font: DEFAULT_CODE_FONT,
    lineCount: LINE_COUNT,
    zooms: ZOOMS,
  };
  const atlasCache = new Map<string, AtlasData>();
  let alphaMode: AlphaMode = "premultiplied";
  const getAtlas = (zoom: number, kind: AtlasKind): AtlasData => {
    const key = `${kind}:${String(zoom)}:${alphaMode}`;
    const cached = atlasCache.get(key);
    if (cached) return cached;
    const renderer = renderers.get(
      kind === "exact"
        ? "atlas-exact"
        : kind === "phased"
          ? "atlas-phased"
          : "atlas-discrete",
    );
    if (!renderer) throw new Error(`WebGL renderer unavailable for ${kind}`);
    const atlas = atlasRecords(
      layouts,
      metrics,
      zoom,
      kind,
      renderer,
      alphaMode,
    );
    atlasCache.set(key, atlas);
    return atlas;
  };
  const render = (zoom: number): void => {
    domLayer.style.transform = `scale(${String(zoom)})`;
    renderCanvasVariant(canvasRaster, lines, layouts, metrics, zoom);
    const staleRenderer = renderers.get("canvas-stale");
    const staleCanvas = atlasCanvases.get("canvas-stale");
    if (staleRenderer && staleCanvas) {
      staleRenderer.uploadCanvas(staleSource);
      staleRenderer.drawImage(staleSource, zoom);
    }
    (["exact", "phased", "discrete"] as const).forEach((kind) => {
      const variant =
        kind === "exact"
          ? "atlas-exact"
          : kind === "phased"
            ? "atlas-phased"
            : "atlas-discrete";
      const renderer = renderers.get(variant);
      if (renderer)
        renderer.drawAtlas(
          getAtlas(zoom, kind),
          layouts,
          zoom,
          metrics.baseline,
          metrics.lineHeight,
          alphaMode,
        );
    });
    status.textContent = `zoom ${zoom.toFixed(2)} — source ${state.sourcePath}`;
  };
  const rasterCost = (lineCount: number): CanvasCost => {
    const widgetLines = Array.from(
      { length: lineCount },
      (_, index) => lines[index % lines.length] ?? "",
    );
    const widgetLayouts = createLayouts(widgetLines, metrics);
    const rasterStart = performance.now();
    const raster = rasterizeCanvas(widgetLines, widgetLayouts, metrics, 1);
    const rasterMs = performance.now() - rasterStart;
    const staleRenderer = renderers.get("canvas-stale");
    if (!staleRenderer) throw new Error("Canvas stale renderer unavailable");
    const uploadMs = staleRenderer.uploadCanvas(raster);
    return {
      rasterMs,
      uploadMs,
      textureBytes: raster.width * raster.height * 4,
    };
  };
  const atlasCost = (kind: AtlasKind): AtlasCost => {
    const renderer = renderers.get(
      kind === "exact" ? "atlas-exact" : "atlas-phased",
    );
    if (!renderer) throw new Error(`Atlas renderer unavailable for ${kind}`);
    const atlas = atlasRecords(layouts, metrics, 1, kind, renderer, alphaMode);
    return {
      buildMs: atlas.buildMs,
      rasterMs: atlas.rasterMs,
      uploadMs: atlas.uploadMs,
      textureBytes: atlas.memoryBytes,
    };
  };
  const measureCosts = (): SpikeApi["measureCosts"] extends () => infer Result
    ? Result
    : never => ({
    canvas: {
      fortyLines: Array.from({ length: 5 }, () => rasterCost(LINE_COUNT)),
      twoThousandLines: Array.from({ length: 5 }, () => rasterCost(2000)),
    },
    atlas: {
      exact: Array.from({ length: 5 }, () => atlasCost("exact")),
      phased: Array.from({ length: 5 }, () => atlasCost("phased")),
    },
  });
  window.__spikeH = {
    getState: () => state,
    setZoom: render,
    setAlphaMode: (mode) => {
      alphaMode = mode;
      render(1);
    },
    measureCosts,
  };
  readyState.textContent = datasetAvailable
    ? "ready"
    : "not ready — reference dataset unavailable";
  render(1);
}

buildSpike();
