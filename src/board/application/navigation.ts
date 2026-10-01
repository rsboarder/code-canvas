import { Camera } from "../domain/camera";

export function panCamera(
  camera: Camera,
  deltaX: number,
  deltaY: number,
): void {
  camera.pan({ x: deltaX, y: deltaY });
}

export function zoomCamera(
  camera: Camera,
  cursorX: number,
  cursorY: number,
  factor: number,
): void {
  camera.zoomToward({ x: cursorX, y: cursorY }, factor);
}
