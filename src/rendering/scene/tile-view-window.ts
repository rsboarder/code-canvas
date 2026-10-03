import type { CameraView } from "../../board/index";
import type { Rect } from "../../shared/geometry/geometry";
import type { Viewport } from "../viewport";
import { viewBoundsAtZoom } from "./tile-sets";

const zoomBoundsInput = {
  cameraOffsetX: 0,
  cameraOffsetY: 0,
  currentZoom: 1,
  targetZoom: 1,
  focusX: 0,
  focusY: 0,
  viewportWidth: 0,
  viewportHeight: 0,
};

export interface ViewWindow {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BodyViewWindowInput {
  camera: CameraView;
  viewport: Viewport;
  frame: Rect;
  bodyTop: number;
  contentScroll: number;
}

export interface PrefetchViewWindowInput extends BodyViewWindowInput {
  targetZoom: number;
  focusX: number;
  focusY: number;
}

export function bodyViewWindow(
  input: BodyViewWindowInput,
  out: ViewWindow,
): boolean {
  const worldLeft = -input.camera.offsetX / input.camera.scale;
  const worldRight =
    (input.viewport.width - input.camera.offsetX) / input.camera.scale;
  const worldTop = -input.camera.offsetY / input.camera.scale;
  const worldBottom =
    (input.viewport.height - input.camera.offsetY) / input.camera.scale;
  const bodyTop = input.frame.y + input.bodyTop;
  const bodyBottom = input.frame.y + input.frame.height;
  if (
    worldRight <= input.frame.x ||
    worldLeft >= input.frame.x + input.frame.width ||
    worldBottom <= bodyTop ||
    worldTop >= bodyBottom
  )
    return false;
  out.left = Math.max(0, worldLeft - input.frame.x);
  out.right = Math.min(input.frame.width, worldRight - input.frame.x);
  out.top = Math.max(0, worldTop - bodyTop) + input.contentScroll;
  out.bottom =
    Math.min(input.frame.height - input.bodyTop, worldBottom - bodyTop) +
    input.contentScroll;
  return out.right > out.left && out.bottom > out.top;
}

export function prefetchViewWindow(
  input: PrefetchViewWindowInput,
  out: ViewWindow,
): void {
  zoomBoundsInput.cameraOffsetX = input.camera.offsetX;
  zoomBoundsInput.cameraOffsetY = input.camera.offsetY;
  zoomBoundsInput.currentZoom = input.camera.scale;
  zoomBoundsInput.targetZoom = input.targetZoom;
  zoomBoundsInput.focusX = input.focusX;
  zoomBoundsInput.focusY = input.focusY;
  zoomBoundsInput.viewportWidth = input.viewport.width;
  zoomBoundsInput.viewportHeight = input.viewport.height;
  viewBoundsAtZoom(zoomBoundsInput, out);
  const bodyTop = input.frame.y + input.bodyTop;
  out.left -= input.frame.x;
  out.top = out.top - bodyTop + input.contentScroll;
  out.right -= input.frame.x;
  out.bottom = out.bottom - bodyTop + input.contentScroll;
}
