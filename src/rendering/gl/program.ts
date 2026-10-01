export function createProgram(
  gl: WebGL2RenderingContext,
  name: string,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `${name} vertex`,
    vertexSource,
  );
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `${name} fragment`,
    fragmentSource,
  );
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "no linker log";
    throw new Error(`${name} link failed: ${log}`);
  }
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  name: string,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`${name}: could not allocate shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "no compiler log";
    throw new Error(`${name} compile failed: ${log}`);
  }
  return shader;
}
