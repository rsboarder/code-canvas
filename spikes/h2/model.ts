import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  LineLayout,
  type LayoutCell,
} from "../../src/code-view/domain/line-layout";
import { createTextMetrics } from "../../src/rendering/text/text-metrics";
import { pickDiscreteRasterSize, type RasterAtlas } from "../h/renderer";
import {
  BODY_HEIGHT,
  HEADER_HEIGHT,
  WIDGET_WIDTH,
  type ExpectedWidget,
} from "./pure";

export const VIEW_WIDTH = 1200;
export const VIEW_HEIGHT = 720;
export const DPR =
  typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
export const GRID_COLUMNS = 10;
export const GRID_ROWS = 20;
export const GRID_GAP = 40;
export const TILE_DEVICE_SIZE = 512;
export const TILE_ATLAS_SIZE = 3072;
export const TILE_SLOTS = TILE_ATLAS_SIZE / TILE_DEVICE_SIZE;
export const TILE_MEMORY_BUDGET = TILE_ATLAS_SIZE * TILE_ATLAS_SIZE * 4;
export const MAIN_TILE_BUDGET_MS = 4;
export const TEXT_THRESHOLD_DEVICE_PX = 9;
export const BACKGROUND = [0.094, 0.118, 0.157] as const;
export const COLORS = ["#d9e1ee", "#8ee0a4", "#e8c98e", "#a8b6ff"] as const;
export const COLOR_RGB = [
  [0.851, 0.882, 0.933],
  [0.557, 0.878, 0.643],
  [0.91, 0.788, 0.557],
  [0.659, 0.714, 1],
] as const;

export type RendererName = "atlas" | "tiles-main" | "tiles-worker";

export interface Widget extends ExpectedWidget {
  readonly index: number;
  readonly lines: readonly string[];
  readonly cells: readonly (readonly LayoutCell[])[];
}

export interface Tile {
  readonly key: string;
  readonly widget: Widget;
  readonly tileX: number;
  readonly tileY: number;
  readonly rasterZoom: number;
  // Whole-tile-row content shift this tile was rastered against (0 when the
  // widget isn't scrolled): the on-screen slot (tileX, tileY) stays fixed,
  // but which source lines are painted into it shifts by scrollBucket tile
  // rows. A tiles renderer is a simplification that scrolls in whole-tile
  // increments rather than sliding sub-tile-smoothly; a bucket change is a
  // new cache key, so it is handled by the same "rasterize what's missing
  // within budget" path pan already uses for newly exposed tiles.
  readonly scrollBucket: number;
  readonly worldX: number;
  readonly worldY: number;
  readonly width: number;
  readonly height: number;
  // Fraction (0, 1] of the rastered TILE_DEVICE_SIZE square that is valid
  // content: a tile clamped at a widget's right/bottom edge still rasters
  // assuming the full (unclamped) grid-cell world size, so only this
  // fraction of the texture maps onto tile.width/height on screen.
  readonly uvWidth: number;
  readonly uvHeight: number;
  slotX: number;
  slotY: number;
  ready: boolean;
  pending: boolean;
  lastUsed: number;
  glyphCount: number;
}

export type H2Atlas = RasterAtlas & {
  readonly texture: WebGLTexture;
  readonly uploadMs: number;
  readonly buildMs: number;
  readonly slotTexture: WebGLTexture;
  readonly slotCount: number;
};

// Instanced glyph record: local x within the widget's content, line row,
// atlas slot index, palette index — no world coordinates, no per-glyph UV or
// size (D6 "Glyph instance"); geometry/UV come from the slot table texture,
// widget position/scroll/clip from per-draw-call uniforms.
export const ATLAS_INSTANCE_FLOATS = 4;
export const ATLAS_INSTANCE_BYTES = ATLAS_INSTANCE_FLOATS * 4;

// A line range an atlas widget buffer was built for (D7 "line window");
// `lastLine` is exclusive.
export interface WidgetWindow {
  readonly firstLine: number;
  readonly lastLine: number;
}

export interface WidgetInstanceBuffer {
  readonly buffer: WebGLBuffer;
  readonly vao: WebGLVertexArrayObject;
  readonly instanceCount: number;
  readonly glyphCount: number;
  readonly window: WidgetWindow;
}

export type ScrollOffsets = ReadonlyMap<number, number>;

export function scrollOffsetFor(
  offsets: ScrollOffsets,
  widgetIndex: number,
): number {
  return offsets.get(widgetIndex) ?? 0;
}

// One screen's worth of lines: both the strictly-visible line count and the
// atlas line window's margin on each side are this size (D6 "Line window":
// "the visible lines plus one screen's worth of margin above and below").
export const VISIBLE_LINE_COUNT = Math.ceil(
  BODY_HEIGHT / DEFAULT_CODE_FONT.lineHeight,
);

export function visibleLineRange(
  widget: Widget,
  offsets: ScrollOffsets,
): WidgetWindow {
  const firstLine = Math.max(
    0,
    Math.floor(
      scrollOffsetFor(offsets, widget.index) / DEFAULT_CODE_FONT.lineHeight,
    ),
  );
  return {
    firstLine,
    lastLine: Math.min(widget.cells.length, firstLine + VISIBLE_LINE_COUNT),
  };
}

export function windowCoversRange(
  window: WidgetWindow,
  range: WidgetWindow,
): boolean {
  return (
    window.firstLine <= range.firstLine && window.lastLine >= range.lastLine
  );
}

export function widgetContentHeight(widget: Widget): number {
  return widget.lines.length * DEFAULT_CODE_FONT.lineHeight;
}

export function maxScrollFor(widget: Widget): number {
  return Math.max(0, widgetContentHeight(widget) - BODY_HEIGHT);
}

export function clampScroll(widget: Widget, offset: number): number {
  return Math.max(0, Math.min(offset, maxScrollFor(widget)));
}

export interface RuntimeMetrics {
  readonly renderer: RendererName;
  readonly frameCount: number;
  readonly jsFrameP50Ms: number;
  readonly jsFrameP99Ms: number;
  readonly rafIntervalP50Ms: number;
  readonly rafIntervalP99Ms: number;
  readonly rafDroppedFrames: number;
  readonly wheelHandlerP99Ms: number;
  readonly longAnimationFrameCount: number;
  readonly longAnimationFrameP99Ms: number;
  readonly longTaskCount: number;
  readonly longTaskP99Ms: number;
  readonly gpuMsMedian: number | "not available";
  readonly gpuMsP99: number | "not available";
  readonly gpuTimerAvailable: boolean;
  readonly detailLevel: "text" | "flat";
  readonly flatDetailFrames: number;
  readonly droppedTileFrames: number;
  readonly tilesRasterized: number;
  readonly residentTileGlyphs: number;
  readonly tilesRasterizedDuringGesture: number;
  readonly tilesUploaded: number;
  readonly rasterMsMedian: number;
  readonly rasterMsP99: number;
  readonly uploadMsMedian: number;
  readonly imageBitmapTransferUploadMsMedian: number;
  readonly emptyTileFrames: number;
  readonly timeToSharpMs: number | "not measured";
  readonly tileMemoryBytes: number;
  readonly coveredTileArea: number;
  readonly atlasSizeSwitches: number;
  readonly atlasBuilds: number;
  readonly atlasTextureCreations: number;
  readonly atlasInstanceBufferRebuilds: number;
  readonly atlasInstanceBufferPartialUpdates: number;
  readonly atlasGestureViolations: number;
  readonly atlasBuildsDuringGesture: number;
  readonly atlasTextureCreationsDuringGesture: number;
  readonly atlasInstanceBufferRebuildsDuringGesture: number;
  readonly atlasPreparationFramesDuringGesture: number;
  readonly atlasPreparationMsMedian: number;
  readonly atlasPreparationMsP99: number;
  readonly atlasPreparationCreateMsMax: number;
  readonly atlasPreparationFrames: number;
  readonly atlasBuildMs: number;
  readonly atlasMemoryBytes: number;
  readonly atlasWidgetBuildMsMedian: number;
  readonly atlasWidgetBuildMsP99: number;
  readonly atlasWidgetBuildMsMax: number;
  readonly atlasUploadMsMedian: number;
  readonly atlasUploadMsP99: number;
  readonly atlasMissingTextFrames: number;
  readonly atlasInstanceBytes: number;
  readonly atlasDrawCallCount: number;
  readonly atlasWindowRebuilds: number;
  readonly atlasWindowBuildMsP99: number;
  readonly drawnGlyphCount: number;
}

export interface SpikeApi {
  readonly getState: () => Record<string, unknown>;
  readonly resetMetrics: () => void;
  readonly setCamera: (x: number, y: number, zoom: number) => void;
  readonly getMetrics: () => RuntimeMetrics;
  readonly getSceneCheck: () => { readonly drawnGlyphs: number };
  readonly getValidation: () => {
    readonly expectedGlyphs: number;
    readonly actualGlyphs: number;
    readonly expectedTileArea: number;
    readonly actualTileArea: number;
    readonly nonBackgroundPixels: number;
    readonly glError: string | null;
  };
  readonly disableValidationLint: () => void;
  readonly endGesture: () => void;
  readonly setForceFlat: (value: boolean) => void;
}

declare global {
  interface Window {
    __spikeH2?: SpikeApi;
  }
}

export const rawFiles = import.meta.glob<string>(
  "/fixtures/reference-dataset/**/*.{ts,tsx}",
  { eager: true, import: "default", query: "?raw" },
);

export function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Spike H2 is missing ${label}`);
  return value;
}

export function colorForLine(lineIndex: number): string {
  return COLORS[lineIndex % COLORS.length] ?? COLORS[0];
}

export function colorRgb(lineIndex: number): readonly [number, number, number] {
  return COLOR_RGB[lineIndex % COLOR_RGB.length] ?? COLOR_RGB[0];
}

// The product shows whole Reference Dataset files (up to 2000 lines, per
// spec/design), not a lightweight slice: the 80-line cap this used to apply
// made every H2 measurement several times lighter than the product. Widget 0
// (the scroll scenario's target, `measure-shared.ts`'s pointer at 380,400)
// must hold more than 3000 px of content, so it is deterministically
// assigned the dataset's longest file by line count (ties broken by path —
// the existing sort order below), not whichever file happens to sort first.
function withLongestFileFirst(
  entries: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  if (entries.length === 0) return entries;
  let longestIndex = 0;
  let longestLineCount = 0;
  entries.forEach(([, source], index) => {
    const lineCount = source.split("\n").length;
    if (lineCount > longestLineCount) {
      longestLineCount = lineCount;
      longestIndex = index;
    }
  });
  if (longestIndex === 0) return entries;
  const longest = entries[longestIndex];
  if (!longest) return entries;
  return [
    longest,
    ...entries.slice(0, longestIndex),
    ...entries.slice(longestIndex + 1),
  ];
}

export function createWidgets(
  metrics: ReturnType<typeof createTextMetrics>,
): Widget[] {
  const entries = withLongestFileFirst(
    Object.entries(rawFiles).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const fallback = `/* H2 fallback */\nconst value = 42;\nreturn <Widget value={value} />;`;
  return Array.from({ length: GRID_COLUMNS * GRID_ROWS }, (_, index) => {
    const source = entries[index]?.[1] ?? entries[0]?.[1] ?? fallback;
    const lines = source.split("\n");
    const layouts = lines.map((line) => new LineLayout(line, metrics));
    return {
      index,
      x: (index % GRID_COLUMNS) * (WIDGET_WIDTH + GRID_GAP),
      y:
        Math.floor(index / GRID_COLUMNS) *
        (BODY_HEIGHT + HEADER_HEIGHT + GRID_GAP),
      lines,
      cells: layouts.map((layout) => layout.cells(0)),
    };
  });
}

export function rasterSizeForZoom(zoom: number): number {
  return pickDiscreteRasterSize(DEFAULT_CODE_FONT.size * zoom);
}

export function tileWorldSize(rasterZoom: number): number {
  return TILE_DEVICE_SIZE / (DPR * rasterZoom);
}

export function countNonBackgroundPixels(pixels: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const productDistance =
      Math.abs((pixels[index] ?? 0) - 24) +
      Math.abs((pixels[index + 1] ?? 0) - 30) +
      Math.abs((pixels[index + 2] ?? 0) - 40);
    const widgetDistance =
      Math.abs((pixels[index] ?? 0) - 31) +
      Math.abs((pixels[index + 1] ?? 0) - 38) +
      Math.abs((pixels[index + 2] ?? 0) - 51);
    if (productDistance > 18 && widgetDistance > 18) count += 1;
  }
  return count;
}

export function webGlErrorName(
  gl: WebGL2RenderingContext,
  error: GLenum,
): string {
  if (error === gl.INVALID_ENUM) return "INVALID_ENUM";
  if (error === gl.INVALID_VALUE) return "INVALID_VALUE";
  if (error === gl.INVALID_OPERATION) return "INVALID_OPERATION";
  if (error === gl.INVALID_FRAMEBUFFER_OPERATION)
    return "INVALID_FRAMEBUFFER_OPERATION";
  if (error === gl.OUT_OF_MEMORY) return "OUT_OF_MEMORY";
  return `UNKNOWN_ERROR_${String(error)}`;
}
