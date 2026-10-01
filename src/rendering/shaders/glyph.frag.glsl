#version 300 es
precision highp float;
uniform sampler2D atlas;
uniform sampler2D palette;
uniform vec4 widget;
uniform float bodyTop;
in vec2 uv;
flat in int colorIndex;
in vec2 worldPosition;
out vec4 color;

void main() {
  if (worldPosition.x < widget.x || worldPosition.x > widget.x + widget.z ||
      worldPosition.y < widget.y || worldPosition.y > widget.y + widget.w) discard;
  float alpha = texture(atlas, uv).r;
  color = vec4(texture(palette, vec2((float(colorIndex) + 0.5) / 256.0, 0.5)).rgb, alpha);
}
