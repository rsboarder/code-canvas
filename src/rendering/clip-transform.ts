export interface WorldToClipInput {
  readonly worldX: number;
  readonly worldY: number;
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
  readonly viewportWidthCss: number;
  readonly viewportHeightCss: number;
  readonly devicePixelRatio: number;
}

export interface ClipPoint {
  readonly x: number;
  readonly y: number;
}

export function worldToClip(input: WorldToClipInput): ClipPoint {
  const pixelX =
    (input.worldX * input.cameraScale + input.cameraOffsetX) *
    input.devicePixelRatio;
  const pixelY =
    (input.worldY * input.cameraScale + input.cameraOffsetY) *
    input.devicePixelRatio;
  const resolutionX = input.viewportWidthCss * input.devicePixelRatio;
  const resolutionY = input.viewportHeightCss * input.devicePixelRatio;
  return {
    x: (pixelX / resolutionX) * 2 - 1,
    y: -((pixelY / resolutionY) * 2 - 1),
  };
}
