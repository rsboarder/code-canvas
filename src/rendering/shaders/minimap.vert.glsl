#version 300 es
layout(location = 0) in vec2 position;
layout(location = 1) in float widgetRow;
layout(location = 2) in float layer;
layout(location = 3) in float rows;
uniform vec2 resolution;
uniform float devicePixelRatio;
uniform vec2 cameraOffset;
uniform float cameraScale;
uniform float bodyTop;
uniform float lineHeight;
uniform sampler2D widgetTable;
out vec2 uv;
flat out float layerOut;
flat out vec4 frameOut;
out vec2 worldPosition;

void main() {
  vec4 frame = texelFetch(widgetTable, ivec2(0, int(widgetRow)), 0);
  vec4 scroll = texelFetch(widgetTable, ivec2(1, int(widgetRow)), 0);
  float contentHeight = min(rows * lineHeight, frame.w - bodyTop);
  vec2 world = vec2(frame.x, frame.y + bodyTop) +
    position * vec2(frame.z, contentHeight);
  vec2 pixel = (world * cameraScale + cameraOffset) * devicePixelRatio;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, scroll.y * 2.0 - 1.0, 1.0);
  uv = vec2(position.x, position.y * rows / 512.0);
  layerOut = layer;
  frameOut = frame;
  worldPosition = world;
}
