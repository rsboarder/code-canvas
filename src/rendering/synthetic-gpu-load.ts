const VERTEX_SHADER = `#version 300 es
void main() {
  if (gl_VertexID == 0) gl_Position = vec4(-1.0, -1.0, 0.0, 1.0);
  else if (gl_VertexID == 1) gl_Position = vec4(3.0, -1.0, 0.0, 1.0);
  else gl_Position = vec4(-1.0, 3.0, 0.0, 1.0);
}`;

const SYNTHETIC_GPU_LOAD_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform int syntheticGpuLoadIterations;
out vec4 syntheticGpuLoadColor;
void main() {
  vec2 value = gl_FragCoord.xy;
  float accumulator = 0.0;
  for (int iteration = 0; iteration < 100000; iteration++) {
    if (iteration >= syntheticGpuLoadIterations) break;
    accumulator = fract(accumulator * 1.000001 + dot(value, vec2(0.0001, 0.00013)));
    value = value.yx + vec2(accumulator, 0.00001);
  }
  syntheticGpuLoadColor = vec4(accumulator, value.x * 0.00001, 0.0, 1.0);
}`;

export default class SyntheticGpuLoad {
  private readonly iterationsLocation: WebGLUniformLocation;
  private iterations = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 is required for the synthetic load");
    const program = createProgram(gl);
    const location = gl.getUniformLocation(
      program,
      "syntheticGpuLoadIterations",
    );
    if (!location) throw new Error("Synthetic GPU load uniform is unavailable");
    this.gl = gl;
    this.program = program;
    this.iterationsLocation = location;
  }

  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;

  draw(iterations: number): void {
    this.iterations = iterations;
    this.gl.useProgram(this.program);
    this.gl.uniform1i(this.iterationsLocation, this.iterations);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    SYNTHETIC_GPU_LOAD_FRAGMENT_SHADER,
  );
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(
      gl.getProgramInfoLog(program) ?? "Synthetic GPU load link failed",
    );
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Synthetic GPU load shader unavailable");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(
      gl.getShaderInfoLog(shader) ?? "Synthetic GPU load compile failed",
    );
  }
  return shader;
}
