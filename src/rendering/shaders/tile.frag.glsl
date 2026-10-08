#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D tiles;
uniform vec2 halfTexel;
uniform float devicePixelRatio;
uniform float cameraScale;
uniform float bodyTop;
uniform float gutterWidth;
uniform float contentAlpha;
uniform float labelAlpha;
in vec2 uv;
flat in vec2 uvMin;
flat in vec2 uvMax;
flat in vec4 frameOut;
flat in float regionOut;
in vec2 worldPosition;
out vec4 color;

void main() {
  float frameInset = 1.0 / (devicePixelRatio * cameraScale);
  float frameRight = frameOut.x + frameOut.z;
  float frameBottom = frameOut.y + frameOut.w;
  bool outsideFrame =
    worldPosition.x < frameOut.x + frameInset ||
    worldPosition.x > frameRight - frameInset ||
    worldPosition.y < frameOut.y + frameInset ||
    worldPosition.y > frameBottom - frameInset;
  bool inBody = regionOut < 0.5;
  bool outsideBody = worldPosition.y < frameOut.y + bodyTop;
  bool outsideHeader = worldPosition.y >= frameOut.y + bodyTop;
  bool inGutter = worldPosition.x >= frameRight - frameInset - gutterWidth;
  if (
    outsideFrame ||
    (inBody && (outsideBody || inGutter)) ||
    (regionOut >= 0.5 && regionOut < 1.5 && outsideHeader)
  ) discard;
  vec4 tileColor = texture(tiles, clamp(uv, uvMin + halfTexel, uvMax - halfTexel));
  float alpha = regionOut < 0.5 ? contentAlpha :
    (regionOut >= 1.5 ? labelAlpha : 1.0);
  color = vec4(tileColor.rgb, tileColor.a * alpha);
}
