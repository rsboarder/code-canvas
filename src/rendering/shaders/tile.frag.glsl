#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray tiles;
uniform vec4 widget;
in vec2 uv;
flat in float layerOut;
in vec2 worldPosition;
out vec4 color;

void main() {
  if (worldPosition.x < widget.x || worldPosition.x > widget.x + widget.z ||
      worldPosition.y < widget.y || worldPosition.y > widget.y + widget.w) discard;
  color = texture(tiles, vec3(uv, layerOut));
}
