import type { Vec2 } from "./geometry";

export interface CameraPosition {
  x: number;
  y: number;
  zoom: number;
}

export function boardToScreen(
  board: Vec2,
  camera: CameraPosition,
  out: Vec2,
): Vec2 {
  out.x = board.x * camera.zoom + camera.x;
  out.y = board.y * camera.zoom + camera.y;
  return out;
}

export function screenToBoard(
  screen: Vec2,
  camera: CameraPosition,
  out: Vec2,
): Vec2 {
  out.x = (screen.x - camera.x) / camera.zoom;
  out.y = (screen.y - camera.y) / camera.zoom;
  return out;
}

export interface ZoomToPointOptions {
  camera: CameraPosition;
  screenPoint: Vec2;
  factor: number;
  minZoom: number;
  maxZoom: number;
}

export function zoomToPoint(
  options: ZoomToPointOptions,
  out: CameraPosition,
): CameraPosition {
  const { camera, screenPoint, factor, minZoom, maxZoom } = options;
  const nextZoom = Math.min(maxZoom, Math.max(minZoom, camera.zoom * factor));
  const boardX = (screenPoint.x - camera.x) / camera.zoom;
  const boardY = (screenPoint.y - camera.y) / camera.zoom;
  out.x = screenPoint.x - boardX * nextZoom;
  out.y = screenPoint.y - boardY * nextZoom;
  out.zoom = nextZoom;
  return out;
}
