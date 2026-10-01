#version 300 es
layout(location = 0) in vec2 position;
uniform vec2 resolution;
uniform float devicePixelRatio;
uniform vec2 cameraOffset;
uniform float cameraScale;
uniform vec4 widget;
out vec2 worldPosition;

void main() {
  vec2 world = widget.xy + position * widget.zw;
  vec2 pixel = (world * cameraScale + cameraOffset) * devicePixelRatio;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  worldPosition = world;
}
