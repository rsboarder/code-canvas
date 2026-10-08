#version 300 es
precision highp float;
uniform vec4 backgroundColor;
uniform vec4 headerColor;
uniform vec4 frameColor;
uniform vec4 scrollThumbColor;
uniform float devicePixelRatio;
uniform float cameraScale;
uniform float contentAlpha;
uniform float bodyTop;
uniform float gutterWidth;
uniform float minimumThumbHeight;
in vec2 localPosition;
flat in vec4 widgetFrame;
flat in vec2 scrollState;
out vec4 color;

void main() {
  vec2 local = localPosition * widgetFrame.zw;
  float frameThickness = 1.0 / (devicePixelRatio * cameraScale);
  bool frame = local.x < frameThickness ||
    local.y < frameThickness ||
    local.x >= widgetFrame.z - frameThickness ||
    local.y >= widgetFrame.w - frameThickness;
  if (frame) {
    color = frameColor;
    return;
  }
  if (local.y < bodyTop) {
    color = headerColor;
    return;
  }

  float bodyHeight = max(0.0, widgetFrame.w - bodyTop);
  float contentScroll = scrollState.x;
  float maxContentScroll = scrollState.y;
  bool hasScroll = maxContentScroll > 0.0;
  if (hasScroll) {
    float contentHeight = bodyHeight + maxContentScroll;
    float thumbHeight = max(
      minimumThumbHeight,
      bodyHeight * bodyHeight / contentHeight
    );
    float thumbTop = bodyTop +
      (bodyHeight - thumbHeight) * contentScroll / maxContentScroll;
    bool inGutter = local.x >= widgetFrame.z - frameThickness - gutterWidth;
    bool inThumb = local.y >= thumbTop && local.y < thumbTop + thumbHeight;
    if (inGutter && inThumb) {
      color = mix(backgroundColor, scrollThumbColor, contentAlpha);
      return;
    }
  }
  color = backgroundColor;
}
