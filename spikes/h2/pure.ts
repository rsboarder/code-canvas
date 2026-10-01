import { DEFAULT_CODE_FONT } from "../../src/shared/font";

export const VIEW_WIDTH = 1200;
export const VIEW_HEIGHT = 720;
export const WIDGET_WIDTH = 760;
export const BODY_HEIGHT = 900;
export const HEADER_HEIGHT = 40;
export const GRID_COLUMNS = 10;
export const GRID_ROWS = 20;
export const GRID_GAP = 40;

export interface ExpectedWidget {
  readonly x: number;
  readonly y: number;
  readonly cells: readonly (readonly unknown[])[];
}

export interface SceneExpectedCounts {
  readonly visibleWidgets: number;
  readonly glyphs: number;
  readonly tileArea: number;
}

export interface PixelFrame {
  readonly width: number;
  readonly data: Uint8Array; // RGBA, 4 bytes per pixel, same shape as decodePng's Rgba.
}

// A pixel the renderer drew differently with text on than with text forced
// off (same camera, same rects/background) is text; a fixed distance from
// PRODUCT_BACKGROUND/WIDGET_BACKGROUND is not enough, because background
// pixels can legitimately differ from those two reference colours (compositor
// dithering, screenshot edge rounding) without being text — that previously
// produced false positives on an all-rect, no-text frame.
export const TEXT_DIFF_COLOR_THRESHOLD = 60;

export function countTextOutsideWidgetGaps(
  withText: PixelFrame,
  withoutText: PixelFrame,
  cameraX: number,
  cameraY: number,
  zoom: number,
  dpr: number,
): number {
  const columnStep = WIDGET_WIDTH + GRID_GAP;
  const rowStep = BODY_HEIGHT + HEADER_HEIGHT + GRID_GAP;
  const pixelCount =
    Math.min(withText.data.length, withoutText.data.length) / 4;
  // The #scene capture includes its CSS border around the canvas.
  const border = (withText.width / dpr - VIEW_WIDTH) / 2;
  let outside = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const delta =
      Math.abs((withText.data[offset] ?? 0) - (withoutText.data[offset] ?? 0)) +
      Math.abs(
        (withText.data[offset + 1] ?? 0) - (withoutText.data[offset + 1] ?? 0),
      ) +
      Math.abs(
        (withText.data[offset + 2] ?? 0) - (withoutText.data[offset + 2] ?? 0),
      );
    if (delta <= TEXT_DIFF_COLOR_THRESHOLD) continue;
    const screenX = ((index % withText.width) + 0.5) / dpr - border;
    const screenY = (Math.floor(index / withText.width) + 0.5) / dpr - border;
    const worldX = cameraX + screenX / zoom;
    const worldY = cameraY + screenY / zoom;
    const column = Math.floor(worldX / columnStep);
    const row = Math.floor(worldY / rowStep);
    const bodyLeft = column * columnStep;
    const bodyTop = row * rowStep + HEADER_HEIGHT;
    // One device pixel of tolerance: a glyph clipped at the body edge leaves
    // antialiased coverage in the boundary pixel.
    const edge = 1 / dpr / zoom;
    const insideBody =
      column >= 0 &&
      column < GRID_COLUMNS &&
      row >= 0 &&
      row < GRID_ROWS &&
      worldX >= bodyLeft - edge &&
      worldX < bodyLeft + WIDGET_WIDTH + edge &&
      worldY >= bodyTop - edge &&
      worldY < bodyTop + BODY_HEIGHT + edge;
    if (!insideBody) outside += 1;
  }
  return outside;
}

// Cross-renderer text-mask comparison (validate stage): the atlas is the
// reference because its drawn glyph count matches the renderer-independent
// expected count exactly; a tile renderer's text mask must still roughly
// line up with it, same camera, same scenario.
export const TEXT_MASK_COLOR_THRESHOLD = 30;
export const TEXT_MASK_IOU_THRESHOLD = 0.85;
export const TEXT_MASK_MAX_SHIFT_PX = 6;

export function buildTextMask(
  withText: PixelFrame,
  withoutText: PixelFrame,
  threshold = TEXT_MASK_COLOR_THRESHOLD,
): Uint8Array {
  const pixelCount =
    Math.min(withText.data.length, withoutText.data.length) / 4;
  const mask = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const delta =
      Math.abs((withText.data[offset] ?? 0) - (withoutText.data[offset] ?? 0)) +
      Math.abs(
        (withText.data[offset + 1] ?? 0) - (withoutText.data[offset + 1] ?? 0),
      ) +
      Math.abs(
        (withText.data[offset + 2] ?? 0) - (withoutText.data[offset + 2] ?? 0),
      );
    mask[index] = delta > threshold ? 1 : 0;
  }
  return mask;
}

export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const result = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index]) {
        result[index] = 1;
        continue;
      }
      outer: for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx]) {
            result[index] = 1;
            break outer;
          }
        }
      }
    }
  return result;
}

export function intersectionOverUnion(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < length; index += 1) {
    const inA = a[index] !== 0;
    const inB = b[index] !== 0;
    if (inA || inB) union += 1;
    if (inA && inB) intersection += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

// The atlas and the tiles place text with a small constant offset (spike H
// measured the atlas 1-3 CSS px off the DOM), so masks are compared at the
// best shift within +-maxShift device px; the shift is reported separately.
export function bestShiftIoU(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  maxShift: number,
): { readonly iou: number; readonly dx: number; readonly dy: number } {
  const height = Math.floor(Math.min(a.length, b.length) / width);
  let best = { iou: 0, dx: 0, dy: 0 };
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      let intersection = 0;
      let union = 0;
      for (let y = maxShift; y < height - maxShift; y += 1) {
        const rowA = y * width;
        const rowB = (y + dy) * width + dx;
        for (let x = maxShift; x < width - maxShift; x += 1) {
          const inA = a[rowA + x] !== 0;
          const inB = b[rowB + x] !== 0;
          if (inA || inB) union += 1;
          if (inA && inB) intersection += 1;
        }
      }
      const iou = union === 0 ? 1 : intersection / union;
      if (iou > best.iou) best = { iou, dx, dy };
    }
  }
  return best;
}

export function atlasGestureViolationCounter(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string | undefined {
  for (const name of [
    "atlasBuildsDuringGesture",
    "atlasTextureCreationsDuringGesture",
    // Rebuilds for a changed visible-widget set are allowed (D7); rebuilds with
    // an unchanged set are counted separately as atlasGestureViolations.
  ]) {
    if (Number(after[name] ?? 0) > Number(before[name] ?? 0)) return name;
  }
  return undefined;
}

// Keyed by each widget's position in `widgets` (same convention as
// model.ts's Widget.index — createWidgets never reorders the array after
// assigning it), not a separate widget id, so this stays a pure helper with
// no dependency on model.ts's Widget type.
export type ScrollOffsetsByPosition = ReadonlyMap<number, number>;

export function expectedSceneCounts(
  widgets: readonly ExpectedWidget[],
  cameraX: number,
  cameraY: number,
  zoom: number,
  scrollOffsets: ScrollOffsetsByPosition = new Map(),
): SceneExpectedCounts {
  const left = cameraX;
  const top = cameraY;
  const right = cameraX + VIEW_WIDTH / zoom;
  const bottom = cameraY + VIEW_HEIGHT / zoom;
  const visibleLineCount = Math.ceil(
    BODY_HEIGHT / DEFAULT_CODE_FONT.lineHeight,
  );
  let glyphs = 0;
  let tileArea = 0;
  let visibleWidgets = 0;
  widgets.forEach((widget, position) => {
    const widgetBottom = widget.y + HEADER_HEIGHT + BODY_HEIGHT;
    const intersects =
      widget.x < right &&
      widget.x + WIDGET_WIDTH > left &&
      widget.y < bottom &&
      widgetBottom > top;
    if (!intersects) return;
    visibleWidgets += 1;
    // The visible line range follows the widget's scroll offset (D7 "line
    // window"), not always lines 0..visibleLineCount: a scrolled widget 0
    // (the scroll scenario) shows a different slice of its (now full-length,
    // up to 2000-line) file.
    const scrollOffset = scrollOffsets.get(position) ?? 0;
    const firstLine = Math.max(
      0,
      Math.floor(scrollOffset / DEFAULT_CODE_FONT.lineHeight),
    );
    const lastLine = Math.min(
      widget.cells.length,
      firstLine + visibleLineCount,
    );
    for (let line = firstLine; line < lastLine; line += 1)
      glyphs += widget.cells[line]?.length ?? 0;
    const bodyLeft = Math.max(left, widget.x);
    const bodyRight = Math.min(right, widget.x + WIDGET_WIDTH);
    const bodyTop = Math.max(top, widget.y + HEADER_HEIGHT);
    const bodyBottom = Math.min(bottom, widget.y + HEADER_HEIGHT + BODY_HEIGHT);
    tileArea +=
      Math.max(0, bodyRight - bodyLeft) * Math.max(0, bodyBottom - bodyTop);
  });
  return { visibleWidgets, glyphs, tileArea };
}

export function percentile(
  values: readonly number[],
  fraction: number,
): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ] ?? 0
  );
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

export function droppedFrameCount(
  intervalsMs: readonly number[],
  vsyncMs = 1_000 / 120,
): number {
  return intervalsMs.filter((interval) => interval > vsyncMs * 1.5).length;
}

export function gestureSpeedReason(
  elapsedMs: number,
  plannedMs: number,
): string | undefined {
  return elapsedMs <= plannedMs * 1.5
    ? undefined
    : "validation-gesture-too-slow";
}

export function summaryExitCode(
  validationStatuses: readonly ("pass" | "fail" | "timed-out" | "missing")[],
  timeStatuses: readonly ("pass" | "fail" | "timed-out" | "missing")[],
): 0 | 1 | 2 {
  if (
    validationStatuses.some((status) => status === "missing") ||
    timeStatuses.some((status) => status === "missing")
  )
    return 2;
  if (
    validationStatuses.some((status) => status !== "pass") ||
    timeStatuses.some((status) => status !== "pass")
  )
    return 1;
  return 0;
}

export class RunTimedOutError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`timed out after ${String(elapsedMs)} ms`);
    this.name = "RunTimedOutError";
  }
}

export async function runWithCap<T>(
  runner: () => Promise<T>,
  capMs: number,
  onTimeout: () => void | Promise<void>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  try {
    return await Promise.race([
      runner(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void Promise.resolve(onTimeout()).finally(() => {
            reject(new RunTimedOutError(performance.now() - started));
          });
        }, capMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
