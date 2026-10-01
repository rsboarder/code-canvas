import type { Vec2 } from "../../shared/geometry/geometry";

const CAMERA_MIN_SCALE = 0.05;
const CAMERA_MAX_SCALE = 4;

export class Camera {
  private _offset: Vec2;
  private _scale: number;

  constructor(offset: Vec2 = { x: 0, y: 0 }, scale = 1) {
    this._offset = { ...offset };
    this._scale = clampScale(scale);
  }

  get offset(): Vec2 {
    return { ...this._offset };
  }

  get scale(): number {
    return this._scale;
  }

  get offsetX(): number {
    return this._offset.x;
  }

  get offsetY(): number {
    return this._offset.y;
  }

  setPosition(offset: Vec2, scale: number): void {
    this._offset = { ...offset };
    this._scale = clampScale(scale);
  }

  pan(delta: Vec2): void {
    this._offset.x += delta.x;
    this._offset.y += delta.y;
  }

  zoomToward(screenPoint: Vec2, factor: number): void {
    const nextScale = clampScale(this._scale * factor);
    const boardPoint = {
      x: (screenPoint.x - this._offset.x) / this._scale,
      y: (screenPoint.y - this._offset.y) / this._scale,
    };
    this._scale = nextScale;
    this._offset = {
      x: screenPoint.x - boardPoint.x * nextScale,
      y: screenPoint.y - boardPoint.y * nextScale,
    };
  }
}

function clampScale(scale: number): number {
  return Math.min(CAMERA_MAX_SCALE, Math.max(CAMERA_MIN_SCALE, scale));
}
