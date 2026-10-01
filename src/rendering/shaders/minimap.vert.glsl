#version 300 es
layout(location = 0) in vec2 position;
uniform vec2 resolution;
uniform float devicePixelRatio;
uniform vec2 cameraOffset;
uniform float cameraScale;
uniform vec4 widget;
uniform float bodyTop;
uniform float lineHeight;
uniform float uploadedRows;
out vec2 uv;
out vec2 worldPosition;

void main() {
  float contentHeight = min(uploadedRows * lineHeight, widget.w - bodyTop);
  vec2 world = vec2(widget.x, widget.y + bodyTop) + position * vec2(widget.z, contentHeight);
  vec2 pixel = (world * cameraScale + cameraOffset) * devicePixelRatio;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  uv = vec2(position.x, position.y * uploadedRows / 512.0);
  worldPosition = world;
}
