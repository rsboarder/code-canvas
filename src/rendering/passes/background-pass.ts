import type { Camera } from "../../board/index";
import backgroundFragment from "../shaders/background.frag.glsl?raw";
import backgroundVertex from "../shaders/background.vert.glsl?raw";
import { createProgram } from "../gl/program";
import type { WidgetTable } from "../scene/widget-table";
import type { Viewport } from "../viewport";

const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

function parseColor(color: string): readonly [number, number, number] {
  const value = Number.parseInt(color.replace("#", ""), 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  ];
}

export class BackgroundPass {
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly position = 0;
  private readonly resolution;
  private readonly devicePixelRatio;
  private readonly cameraOffset;
  private readonly cameraScale;
  private readonly widget;
  private readonly backgroundColor;
  private readonly backgroundRgb: readonly [number, number, number];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    widgetBackground: string,
  ) {
    this.backgroundRgb = parseColor(widgetBackground);
    this.program = createProgram(
      gl,
      "background",
      backgroundVertex,
      backgroundFragment,
    );
    this.buffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.position);
    gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.resolution = gl.getUniformLocation(this.program, "resolution");
    this.devicePixelRatio = gl.getUniformLocation(
      this.program,
      "devicePixelRatio",
    );
    this.cameraOffset = gl.getUniformLocation(this.program, "cameraOffset");
    this.cameraScale = gl.getUniformLocation(this.program, "cameraScale");
    this.widget = gl.getUniformLocation(this.program, "widget");
    this.backgroundColor = gl.getUniformLocation(
      this.program,
      "backgroundColor",
    );
  }

  draw(camera: Camera, table: WidgetTable, viewport: Viewport): void {
    const values = table.values;
    this.gl.useProgram(this.program);
    this.gl.uniform2f(this.resolution, viewport.width, viewport.height);
    this.gl.uniform1f(this.devicePixelRatio, viewport.devicePixelRatio);
    this.gl.uniform2f(this.cameraOffset, camera.offsetX, camera.offsetY);
    this.gl.uniform1f(this.cameraScale, camera.scale);
    this.gl.uniform4f(
      this.widget,
      values[0] ?? 0,
      values[1] ?? 0,
      values[2] ?? 0,
      values[3] ?? 0,
    );
    const [red, green, blue] = this.backgroundRgb;
    this.gl.uniform4f(this.backgroundColor, red, green, blue, 1);
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    this.gl.bindVertexArray(null);
  }
}
