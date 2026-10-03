#version 300 es
layout(location = 0) in vec2 position;
layout(location = 1) in float localX;
layout(location = 2) in float localY;
layout(location = 3) in float tileWidth;
layout(location = 4) in float tileHeight;
layout(location = 5) in float uvMaxX;
layout(location = 6) in float uvMaxY;
layout(location = 7) in float widgetRow;
layout(location = 8) in float region;
layout(location = 9) in float uvOffsetX;
layout(location = 10) in float uvOffsetY;

uniform vec2 resolution;
uniform float devicePixelRatio;
uniform vec2 cameraOffset;
uniform float cameraScale;
uniform sampler2D widgetTable;
uniform float bodyTop;
uniform vec2 slotUvScale;
// At rest (no gesture in progress) the quad's screen translation is rounded
// to whole device pixels so its texels map 1:1 to the screen (D6 "Tile
// pool"); during a gesture the camera moves continuously and rounding would
// only add jitter.
uniform float snapToDevicePixel;

out vec2 uv;
flat out vec2 uvMin;
flat out vec2 uvMax;
flat out vec4 frameOut;
flat out float regionOut;
out vec2 worldPosition;

void main() {
  vec4 frame = texelFetch(widgetTable, ivec2(0, int(widgetRow)), 0);
  vec4 scroll = texelFetch(widgetTable, ivec2(1, int(widgetRow)), 0);
  vec2 origin = frame.xy + vec2(localX, localY);
  if (region < 0.5) origin.y += bodyTop - scroll.x;
  vec2 originPixel = (origin * cameraScale + cameraOffset) * devicePixelRatio;
  if (snapToDevicePixel > 0.5) originPixel = floor(originPixel + 0.5);
  vec2 cornerPixel = position * vec2(tileWidth, tileHeight) * cameraScale * devicePixelRatio;
  vec2 pixel = originPixel + cornerPixel;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, scroll.y * 2.0 - 1.0, 1.0);
  uvMin = vec2(uvOffsetX, uvOffsetY);
  uvMax = uvMin + vec2(uvMaxX, uvMaxY) * slotUvScale;
  uv = mix(uvMin, uvMax, position);
  frameOut = frame;
  regionOut = region;
  worldPosition = origin + position * vec2(tileWidth, tileHeight);
}
