import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import type { LayoutCell } from "../../src/code-view/domain/line-layout";
import { createTextMetrics } from "../../src/rendering/text/text-metrics";

export type AlphaMode = "straight" | "premultiplied";
export type AtlasKind = "exact" | "phased" | "discrete";

export interface AtlasRecord {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly uvX: number;
  readonly uvY: number;
  readonly uvWidth: number;
  readonly uvHeight: number;
  readonly drawWidth: number;
  readonly drawHeight: number;
  readonly padding: number;
  readonly baseline: number;
  readonly sourceScale: number;
}

export interface AtlasSource {
  readonly cells: readonly (readonly LayoutCell[])[];
}

export interface RasterAtlas {
  readonly width: number;
  readonly height: number;
  readonly memoryBytes: number;
  readonly rasterMs: number;
  readonly records: Map<string, readonly AtlasRecord[]>;
  readonly phased: boolean;
  readonly alphaMode: AlphaMode;
  readonly pixels: Uint8Array;
}

export interface RasterCell {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly color: string;
}

export interface AtlasPreparation {
  readonly rasterSize: number;
  step(budgetMs: number): boolean;
  finish(): RasterAtlas;
}

export const TEXT_VERTEX = `#version 300 es
in vec4 positionUv;
in vec3 colorIn;
uniform vec2 resolution;
uniform vec4 camera;
out vec2 uv;
out vec3 glyphColor;
void main() {
  vec2 pixel = (positionUv.xy - camera.xy) * camera.zw;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  uv = positionUv.zw;
  glyphColor = colorIn;
}`;

export const TEXT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D atlas;
uniform bool straightTexture;
uniform bool premultiplied;
in vec2 uv;
in vec3 glyphColor;
out vec4 color;
void main() {
  vec4 texel = texture(atlas, uv);
  float alpha = straightTexture ? texel.a : texel.r;
  color = premultiplied ? vec4(glyphColor * alpha, alpha) : vec4(glyphColor, alpha);
}`;

export function pickDiscreteRasterSize(targetSize: number): number {
  return (
    [8, 12, 16, 24, 32, 48, 64, 96].find((size) => size >= targetSize) ?? 96
  );
}

export function drawRasterCells(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cells: readonly RasterCell[],
  font: string,
): number {
  context.textBaseline = "alphabetic";
  context.font = font;
  let glyphCount = 0;
  for (const cell of cells) {
    context.fillStyle = cell.color;
    context.fillText(cell.text, cell.x, cell.y);
    glyphCount += 1;
  }
  return glyphCount;
}

// The unique cluster set depends only on text content, not raster size or
// zoom: callers that prepare multiple raster sizes for the same sources (H2's
// AtlasRenderer) should compute this once and pass it to every
// createAtlasPreparation call instead of re-deriving it (a ~200-widget
// flatMap/Set) on every call.
export function computeClusterSet(
  sources: readonly AtlasSource[],
): readonly string[] {
  return [
    ...new Set(
      sources.flatMap((source) =>
        source.cells.flatMap((line) => line.map((cell) => cell.text)),
      ),
    ),
  ];
}

export function rasterizeAtlas(
  sources: readonly AtlasSource[],
  metrics: ReturnType<typeof createTextMetrics>,
  zoom: number,
  kind: AtlasKind,
  dpr: number,
  alphaMode: AlphaMode,
  rasterSizeOverride?: number,
): RasterAtlas {
  const preparation = createAtlasPreparation(
    sources,
    metrics,
    zoom,
    kind,
    dpr,
    alphaMode,
    rasterSizeOverride,
  );
  preparation.step(Number.POSITIVE_INFINITY);
  return preparation.finish();
}

export function createAtlasPreparation(
  sources: readonly AtlasSource[],
  metrics: ReturnType<typeof createTextMetrics>,
  zoom: number,
  kind: AtlasKind,
  dpr: number,
  alphaMode: AlphaMode,
  rasterSizeOverride?: number,
  // Defaulted (not just optional) so existing callers — rasterizeAtlas, and
  // spike H's own single-raster-size usage — keep computing it exactly as
  // before; only a caller that passes its own precomputed set skips the work.
  clusters: readonly string[] = computeClusterSet(sources),
): AtlasPreparation {
  const targetSize = DEFAULT_CODE_FONT.size * zoom;
  const rasterSize =
    rasterSizeOverride ??
    (kind === "discrete" ? pickDiscreteRasterSize(targetSize) : targetSize);
  const sourceScale = targetSize / rasterSize;
  const phased = kind !== "exact";
  const phaseCount = phased ? 4 : 1;
  const drawWidth =
    ((metrics.narrowAdvance * rasterSize) / DEFAULT_CODE_FONT.size + 8) * dpr;
  const drawHeight =
    ((DEFAULT_CODE_FONT.lineHeight * rasterSize) / DEFAULT_CODE_FONT.size) *
    dpr;
  const padding = Math.max(2, Math.ceil(2 * dpr));
  const contentWidth = Math.ceil(drawWidth);
  const contentHeight = Math.ceil(drawHeight);
  const cellWidth = Math.max(24, contentWidth + padding * 2);
  const cellHeight = Math.max(32, contentHeight + padding * 2);
  const columns = 16;
  const rows = Math.ceil((clusters.length * phaseCount) / columns);
  const width = columns * cellWidth;
  const height = Math.max(cellHeight, rows * cellHeight);
  const rasterCanvas = document.createElement("canvas");
  rasterCanvas.width = width;
  rasterCanvas.height = height;
  const context = rasterCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Spike H could not create an atlas context");
  context.clearRect(0, 0, width, height);
  context.fillStyle = "white";
  context.textBaseline = "alphabetic";
  context.font = `${String(rasterSize * dpr)}px ${DEFAULT_CODE_FONT.family}`;
  const records = new Map<string, AtlasRecord[]>();
  let rasterWorkMs = 0;
  let nextCluster = 0;

  const rasterCluster = (cluster: string, clusterIndex: number): void => {
    const choices: AtlasRecord[] = [];
    for (let phase = 0; phase < phaseCount; phase += 1) {
      const slotIndex = clusterIndex * phaseCount + phase;
      const x = (slotIndex % columns) * cellWidth;
      const y = Math.floor(slotIndex / columns) * cellHeight;
      context.fillText(
        cluster,
        x + padding + phase * 0.25,
        y +
          padding +
          ((metrics.baseline * rasterSize) / DEFAULT_CODE_FONT.size) * dpr,
      );
      choices.push({
        x,
        y,
        width: cellWidth,
        height: cellHeight,
        uvX: x + padding,
        uvY: y + padding,
        uvWidth: Math.min(contentWidth, cellWidth - padding * 2),
        uvHeight: Math.min(contentHeight, cellHeight - padding * 2),
        drawWidth,
        drawHeight,
        padding,
        baseline:
          ((metrics.baseline * rasterSize) / DEFAULT_CODE_FONT.size) * dpr,
        sourceScale,
      });
    }
    records.set(cluster, choices);
  };

  return {
    rasterSize,
    step: (budgetMs: number): boolean => {
      const start = performance.now();
      while (nextCluster < clusters.length) {
        const cluster = clusters[nextCluster];
        if (cluster !== undefined) rasterCluster(cluster, nextCluster);
        nextCluster += 1;
        if (performance.now() - start >= budgetMs) {
          rasterWorkMs += performance.now() - start;
          return false;
        }
      }
      rasterWorkMs += performance.now() - start;
      return true;
    },
    finish: (): RasterAtlas => {
      if (nextCluster < clusters.length)
        throw new Error("Atlas preparation is incomplete");
      const pixels = context.getImageData(0, 0, width, height).data;
      const alpha = new Uint8Array(width * height);
      for (let index = 0; index < alpha.length; index += 1)
        alpha[index] = pixels[index * 4 + 3] ?? 0;
      return {
        width,
        height,
        memoryBytes: width * height * (alphaMode === "straight" ? 4 : 1),
        rasterMs: rasterWorkMs,
        records,
        phased,
        alphaMode,
        pixels: alpha,
      };
    },
  };
}

export function createAtlasTexture(
  gl: WebGL2RenderingContext,
  raster: Pick<RasterAtlas, "width" | "height" | "pixels">,
  alphaMode: AlphaMode,
): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (alphaMode === "premultiplied") {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      raster.width,
      raster.height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      raster.pixels,
    );
    return texture;
  }
  const rgba = new Uint8Array(raster.width * raster.height * 4);
  for (let index = 0; index < raster.pixels.length; index += 1) {
    const target = index * 4;
    rgba[target] = 255;
    rgba[target + 1] = 255;
    rgba[target + 2] = 255;
    rgba[target + 3] = raster.pixels[index] ?? 0;
  }
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    raster.width,
    raster.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    rgba,
  );
  return texture;
}
