#version 300 es
precision highp float;
uniform vec4 backgroundColor;
in vec2 worldPosition;
out vec4 color;

void main() {
  color = backgroundColor;
}
