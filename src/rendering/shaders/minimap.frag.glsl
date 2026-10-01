#version 300 es
precision highp float;
uniform sampler2D minimap;
uniform sampler2D palette;
in vec2 uv;
in vec2 worldPosition;
out vec4 color;

void main() {
  float paletteIndex = texture(minimap, uv).r;
  int index = int(floor(paletteIndex * 255.0 + 0.5));
  color = vec4(texture(palette, vec2((float(index) + 0.5) / 256.0, 0.5)).rgb, 1.0);
}
