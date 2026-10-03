#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray minimap;
uniform sampler2D palette;
uniform float devicePixelRatio;
uniform float cameraScale;
in vec2 uv;
flat in float layerOut;
flat in vec4 frameOut;
in vec2 worldPosition;
out vec4 color;

void main() {
  float frameInset = 1.0 / (devicePixelRatio * cameraScale);
  bool outsideFrame =
    worldPosition.x < frameOut.x + frameInset ||
    worldPosition.x > frameOut.x + frameOut.z - frameInset ||
    worldPosition.y < frameOut.y + frameInset ||
    worldPosition.y > frameOut.y + frameOut.w - frameInset;
  if (outsideFrame) discard;
  float paletteIndex = texture(minimap, vec3(uv, layerOut)).r;
  int index = int(floor(paletteIndex * 255.0 + 0.5));
  color = vec4(texture(palette, vec2((float(index) + 0.5) / 256.0, 0.5)).rgb, 1.0);
}
