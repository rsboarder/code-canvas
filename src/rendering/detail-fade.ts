export const DETAIL_FADE_MS = 150;

const MAX_FADE_ELAPSED_MS = 50;

export interface DetailFrame {
  minimapAlpha: number;
  contentAlpha: number;
  labelAlpha: number;
}

export function detailFrameFor(
  textWeight: number,
  out: DetailFrame,
): DetailFrame {
  out.minimapAlpha = 1 - textWeight;
  out.contentAlpha = textWeight;
  out.labelAlpha = 1 - textWeight;
  return out;
}

export function stepTextWeight(
  current: number,
  target: number,
  elapsedMs: number,
): number {
  if (current === target) return target;
  const elapsed = Math.min(Math.max(elapsedMs, 0), MAX_FADE_ELAPSED_MS);
  const step = elapsed / DETAIL_FADE_MS;
  if (target > current) return Math.min(target, current + step);
  return Math.max(target, current - step);
}
