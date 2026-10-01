import type { Page } from "@playwright/test";
import { decodePng, type Rgba } from "../h/png";
import { PRODUCT_BACKGROUND, WIDGET_BACKGROUND } from "./measure-shared";

export interface TextMask {
  readonly width: number;
  readonly pixels: Uint8Array;
  readonly count: number;
}

export interface AlignmentReport {
  readonly beforeFrame: number;
  readonly afterFrame: number;
  readonly shiftX: number;
  readonly shiftY: number;
  readonly distance: number;
}

export function createTextMask(image: Rgba): TextMask {
  const pixels = new Uint8Array(image.width * image.height);
  let count = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const productDistance =
      Math.abs((image.data[index] ?? 0) - PRODUCT_BACKGROUND[0]) +
      Math.abs((image.data[index + 1] ?? 0) - PRODUCT_BACKGROUND[1]) +
      Math.abs((image.data[index + 2] ?? 0) - PRODUCT_BACKGROUND[2]);
    const widgetDistance =
      Math.abs((image.data[index] ?? 0) - WIDGET_BACKGROUND[0]) +
      Math.abs((image.data[index + 1] ?? 0) - WIDGET_BACKGROUND[1]) +
      Math.abs((image.data[index + 2] ?? 0) - WIDGET_BACKGROUND[2]);
    if (productDistance > 18 && widgetDistance > 18) {
      pixels[index / 4] = 1;
      count += 1;
    }
  }
  return { width: image.width, pixels, count };
}

function centroid(mask: TextMask): readonly [number, number] {
  let xTotal = 0;
  let yTotal = 0;
  for (let index = 0; index < mask.pixels.length; index += 1) {
    if (mask.pixels[index] === 0) continue;
    xTotal += index % mask.width;
    yTotal += Math.floor(index / mask.width);
  }
  if (mask.count === 0) return [0, 0];
  return [xTotal / mask.count, yTotal / mask.count];
}

export function alignmentReport(
  before: { readonly index: number; readonly mask: TextMask },
  after: { readonly index: number; readonly mask: TextMask },
): AlignmentReport {
  const [beforeX, beforeY] = centroid(before.mask);
  const [afterX, afterY] = centroid(after.mask);
  const shiftX = afterX - beforeX;
  const shiftY = afterY - beforeY;
  return {
    beforeFrame: before.index,
    afterFrame: after.index,
    shiftX,
    shiftY,
    distance: Math.hypot(shiftX, shiftY),
  };
}

export async function captureScene(page: Page, path?: string): Promise<Rgba> {
  const screenshot = await page
    .locator("#scene")
    .screenshot(path ? { path } : undefined);
  return decodePng(screenshot);
}
