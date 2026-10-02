import type { Vec2 } from "../../shared/geometry/geometry";
import {
  boardToScreen,
  screenToBoard,
  zoomToPoint,
  type CameraPosition,
  type ZoomToPointOptions,
} from "../../shared/geometry";

const CAMERA_MIN_SCALE = 0.05;
const CAMERA_MAX_SCALE = 4;

export class Camera {
  private _offset: Vec2;
  private _scale: number;

  private readonly _positionScratch: CameraPosition = { x: 0, y: 0, zoom: 0 };
  private readonly _zoomRequest: ZoomToPointOptions = {
    camera: this._positionScratch,
    screenPoint: { x: 0, y: 0 },
    factor: 1,
    minZoom: CAMERA_MIN_SCALE,
    maxZoom: CAMERA_MAX_SCALE,
  };

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

  toScreen(boardPoint: Vec2, out: Vec2): Vec2 {
    return boardToScreen(boardPoint, this.refreshPosition(), out);
  }

  toBoard(screenPoint: Vec2, out: Vec2): Vec2 {
    return screenToBoard(screenPoint, this.refreshPosition(), out);
  }

  zoomToward(screenPoint: Vec2, factor: number): void {
    this.refreshPosition();
    this._zoomRequest.screenPoint = screenPoint;
    this._zoomRequest.factor = factor;
    const next = zoomToPoint(this._zoomRequest, this._positionScratch);
    this._offset.x = next.x;
    this._offset.y = next.y;
    this._scale = next.zoom;
  }

  private refreshPosition(): CameraPosition {
    this._positionScratch.x = this._offset.x;
    this._positionScratch.y = this._offset.y;
    this._positionScratch.zoom = this._scale;
    return this._positionScratch;
  }
}

function clampScale(scale: number): number {
  return Math.min(CAMERA_MAX_SCALE, Math.max(CAMERA_MIN_SCALE, scale));
}
