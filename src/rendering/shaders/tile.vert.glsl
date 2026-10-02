#version 300 es
layout(location = 0) in vec2 position;
layout(location = 1) in float localX;
layout(location = 2) in float localY;
layout(location = 3) in float tileWidth;
layout(location = 4) in float tileHeight;
layout(location = 5) in float layer;
layout(location = 6) in float uvMaxX;
layout(location = 7) in float uvMaxY;

uniform vec2 resolution;
uniform float devicePixelRatio;
uniform vec2 cameraOffset;
uniform float cameraScale;
uniform vec4 widget;
// At rest (no gesture in progress) the quad's screen translation is rounded
// to whole device pixels so its texels map 1:1 to the screen (D6 "Tile
// pool"); during a gesture the camera moves continuously and rounding would
// only add jitter.
uniform float snapToDevicePixel;

out vec2 uv;
flat out float layerOut;
out vec2 worldPosition;

void main() {
  vec2 origin = vec2(widget.x + localX, widget.y + localY);
  vec2 originPixel = (origin * cameraScale + cameraOffset) * devicePixelRatio;
  if (snapToDevicePixel > 0.5) originPixel = floor(originPixel + 0.5);
  vec2 cornerPixel = position * vec2(tileWidth, tileHeight) * cameraScale * devicePixelRatio;
  vec2 pixel = originPixel + cornerPixel;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  uv = position * vec2(uvMaxX, uvMaxY);
  layerOut = layer;
  worldPosition = origin + position * vec2(tileWidth, tileHeight);
}
