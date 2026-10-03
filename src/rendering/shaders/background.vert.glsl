#version 300 es
layout(location = 0) in vec2 position;
uniform vec2 resolution;
uniform float devicePixelRatio;
uniform vec2 cameraOffset;
uniform float cameraScale;
uniform sampler2D widgetTable;
uniform int rowCount;
out vec2 localPosition;
flat out vec4 widgetFrame;
flat out vec2 scrollState;

void main() {
  if (gl_InstanceID >= rowCount) {
    gl_Position = vec4(0.0);
    return;
  }
  vec4 frame = texelFetch(widgetTable, ivec2(0, gl_InstanceID), 0);
  vec4 scroll = texelFetch(widgetTable, ivec2(1, gl_InstanceID), 0);
  vec2 world = frame.xy + position * frame.zw;
  vec2 pixel = (world * cameraScale + cameraOffset) * devicePixelRatio;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  float depth = scroll.y;
  gl_Position = vec4(clip.x, -clip.y, depth * 2.0 - 1.0, 1.0);
  localPosition = position;
  widgetFrame = frame;
  scrollState = vec2(scroll.x, scroll.z);
}
