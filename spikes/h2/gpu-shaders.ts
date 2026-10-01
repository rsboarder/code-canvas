import { required } from "./model";

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = required(gl.createShader(gl.VERTEX_SHADER), "a vertex shader");
  gl.shaderSource(vertex, vertexSource);
  gl.compileShader(vertex);
  if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(vertex) ?? "vertex shader failed");
  const fragment = required(
    gl.createShader(gl.FRAGMENT_SHADER),
    "a fragment shader",
  );
  gl.shaderSource(fragment, fragmentSource);
  gl.compileShader(fragment);
  if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(fragment) ?? "fragment shader failed");
  const program = required(gl.createProgram(), "a WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "WebGL link failed");
  return program;
}

export const RECT_VERTEX = `#version 300 es
in vec2 position;
in vec3 inputColor;
uniform vec2 resolution;
uniform vec4 camera;
out vec3 color;
void main() {
  vec2 pixel = (position - camera.xy) * camera.zw;
  gl_Position = vec4(
    pixel.x / resolution.x * 2.0 - 1.0,
    1.0 - pixel.y / resolution.y * 2.0,
    0.0,
    1.0
  );
  color = inputColor;
}`;

export const RECT_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 color;
out vec4 outputColor;
void main() { outputColor = vec4(color, 1.0); }`;

export const TEXTURE_VERTEX = `#version 300 es
in vec4 positionUv;
uniform vec2 resolution;
uniform vec4 camera;
out vec2 uv;
void main() {
  vec2 pixel = (positionUv.xy - camera.xy) * camera.zw;
  gl_Position = vec4(
    pixel.x / resolution.x * 2.0 - 1.0,
    1.0 - pixel.y / resolution.y * 2.0,
    0.0,
    1.0
  );
  uv = positionUv.zw;
}`;

export const TEXTURE_FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D textureSampler;
in vec2 uv;
out vec4 outputColor;
void main() { outputColor = texture(textureSampler, uv); }`;

// Instanced glyph quad: one static unit-quad corner per vertex (divisor 0,
// shared across every widget) plus a compact 16-byte per-glyph instance
// record (divisor 1, see model.ts ATLAS_INSTANCE_BYTES): local x within the
// widget's content, line row, atlas slot index, and palette index. There are
// no world coordinates and no per-glyph UV/size in the instance (D6 "Glyph
// instance"): widget position/scroll/clip come from per-draw-call uniforms
// (one draw call already exists per widget), and per-glyph geometry/UV come
// from the slotTable data texture, indexed by atlas slot — both rebuilt only
// when a raster size's atlas is (re)built, never per frame.
export const ATLAS_INSTANCED_VERTEX = `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in float instX;
layout(location = 2) in float instRow;
layout(location = 3) in float instSlot;
layout(location = 4) in float instPalette;
uniform vec2 resolution;
uniform vec4 camera;
uniform vec2 widgetOrigin;
uniform float widgetScroll;
uniform vec4 widgetClipRect;
uniform float lineHeight;
uniform float baseline;
uniform vec3 palette[4];
uniform highp sampler2D slotTable;
out vec2 uv;
out vec3 glyphColor;
flat out vec4 clipBounds;
void main() {
  int slot = int(instSlot);
  vec4 geom = texelFetch(slotTable, ivec2(slot, 0), 0);
  vec4 uvRect = texelFetch(slotTable, ivec2(slot, 1), 0);
  float glyphX = widgetOrigin.x + instX + geom.x;
  float glyphY =
    widgetOrigin.y + instRow * lineHeight + baseline + geom.y - widgetScroll;
  vec2 position = vec2(glyphX + corner.x * geom.z, glyphY + corner.y * geom.w);
  vec2 pixel = (position - camera.xy) * camera.zw;
  vec2 clip = pixel / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  uv = vec2(mix(uvRect.x, uvRect.z, corner.x), mix(uvRect.y, uvRect.w, corner.y));
  glyphColor = palette[int(instPalette)];
  vec2 clipMin = (widgetClipRect.xy - camera.xy) * camera.zw;
  vec2 clipMax = (widgetClipRect.zw - camera.xy) * camera.zw;
  clipBounds = vec4(clipMin, clipMax);
}`;

export const CLIPPED_TEXT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D atlas;
uniform bool straightTexture;
uniform bool premultiplied;
uniform vec2 resolution;
in vec2 uv;
in vec3 glyphColor;
flat in vec4 clipBounds;
out vec4 color;
void main() {
  vec2 screen = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y);
  if (screen.x < clipBounds.x || screen.y < clipBounds.y ||
      screen.x >= clipBounds.z || screen.y >= clipBounds.w) discard;
  vec4 texel = texture(atlas, uv);
  float alpha = straightTexture ? texel.a : texel.r;
  color = premultiplied ? vec4(glyphColor * alpha, alpha) : vec4(glyphColor, alpha);
}`;
