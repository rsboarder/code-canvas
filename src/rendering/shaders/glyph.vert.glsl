#version 300 es
layout(location = 0) in vec2 position;
layout(location = 1) in float widgetIndex;
layout(location = 2) in float row;
layout(location = 3) in float xOffset;
layout(location = 4) in float atlasSlot;
layout(location = 5) in float paletteIndex;

uniform vec2 resolution;
uniform float devicePixelRatio;
uniform vec2 cameraOffset;
uniform float cameraScale;
uniform vec4 widget;
uniform float bodyTop;
uniform float lineHeight;
uniform float contentScroll;
uniform sampler2D slotTable;

out vec2 uv;
flat out int colorIndex;
out vec2 worldPosition;

const int SLOT_TABLE_UV_ROW = 0;
const int SLOT_TABLE_GEOMETRY_ROW = 1;

void main() {
  int slot = int(atlasSlot + 0.5);
  vec4 uvRect = texelFetch(slotTable, ivec2(slot, SLOT_TABLE_UV_ROW), 0);
  vec4 geometry = texelFetch(slotTable, ivec2(slot, SLOT_TABLE_GEOMETRY_ROW), 0);
  vec2 topLeft = vec2(widget.x + xOffset, widget.y + bodyTop + row * lineHeight - contentScroll + geometry.w - geometry.y);
  vec2 world = topLeft + position * geometry.xy;
  world.x += widgetIndex * 0.0;
  vec2 pixel = (world * cameraScale + cameraOffset) * devicePixelRatio;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  uv = mix(uvRect.xy, uvRect.zw, position);
  colorIndex = int(paletteIndex + 0.5);
  worldPosition = world;
}
