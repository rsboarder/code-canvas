import type { CameraView } from "../../board/index";
import backgroundFragment from "../shaders/background.frag.glsl?raw";
import backgroundVertex from "../shaders/background.vert.glsl?raw";
import { createProgram } from "../gl/program";
import type { WidgetTable } from "../scene/widget-table";
import type { Viewport } from "../viewport";
import {
  WIDGET_FRAME_COLOR,
  WIDGET_HEADER_COLOR,
  WIDGET_SCROLL_GUTTER_WIDTH,
  WIDGET_SCROLL_THUMB_COLOR,
} from "../widget-colors";

const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const MINIMUM_SCROLL_THUMB_HEIGHT = 20;

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
  private readonly widgetTable;
  private readonly rowCount;
  private readonly backgroundColor;
  private readonly backgroundRgb: readonly [number, number, number];
  private readonly headerColor;
  private readonly frameColor;
  private readonly scrollThumbColor;
  private readonly detailLevel;
  private readonly bodyTop;
  private readonly bodyTopValue;
  private readonly gutterWidth;
  private readonly minimumThumbHeight;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    widgetBackground: string,
    private readonly tableTexture: WebGLTexture,
    bodyTop: number,
  ) {
    this.backgroundRgb = parseColor(widgetBackground);
    this.bodyTopValue = bodyTop;
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
    this.widgetTable = gl.getUniformLocation(this.program, "widgetTable");
    this.rowCount = gl.getUniformLocation(this.program, "rowCount");
    this.backgroundColor = gl.getUniformLocation(
      this.program,
      "backgroundColor",
    );
    this.headerColor = gl.getUniformLocation(this.program, "headerColor");
    this.frameColor = gl.getUniformLocation(this.program, "frameColor");
    this.scrollThumbColor = gl.getUniformLocation(
      this.program,
      "scrollThumbColor",
    );
    this.detailLevel = gl.getUniformLocation(this.program, "detailLevel");
    this.bodyTop = gl.getUniformLocation(this.program, "bodyTop");
    this.gutterWidth = gl.getUniformLocation(this.program, "gutterWidth");
    this.minimumThumbHeight = gl.getUniformLocation(
      this.program,
      "minimumThumbHeight",
    );
    gl.useProgram(this.program);
    gl.uniform1i(this.widgetTable, 0);
    this.setColor(this.headerColor, WIDGET_HEADER_COLOR);
    this.setColor(this.frameColor, WIDGET_FRAME_COLOR);
    this.setColor(this.scrollThumbColor, WIDGET_SCROLL_THUMB_COLOR);
  }

  draw(
    camera: CameraView,
    table: WidgetTable,
    viewport: Viewport,
    detailLevel: number,
  ): void {
    this.gl.useProgram(this.program);
    this.gl.uniform2f(this.resolution, viewport.width, viewport.height);
    this.gl.uniform1f(this.devicePixelRatio, viewport.devicePixelRatio);
    this.gl.uniform2f(this.cameraOffset, camera.offsetX, camera.offsetY);
    this.gl.uniform1f(this.cameraScale, camera.scale);
    this.gl.uniform1i(this.rowCount, table.rowCount);
    const [red, green, blue] = this.backgroundRgb;
    this.gl.uniform4f(this.backgroundColor, red, green, blue, 1);
    this.gl.uniform1f(this.detailLevel, detailLevel);
    this.gl.uniform1f(this.bodyTop, this.bodyTopValue);
    this.gl.uniform1f(this.gutterWidth, WIDGET_SCROLL_GUTTER_WIDTH);
    this.gl.uniform1f(this.minimumThumbHeight, MINIMUM_SCROLL_THUMB_HEIGHT);
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tableTexture);
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArraysInstanced(this.gl.TRIANGLE_STRIP, 0, 4, table.rowCount);
    this.gl.bindVertexArray(null);
  }

  private setColor(location: WebGLUniformLocation | null, color: string): void {
    const [red, green, blue] = parseColor(color);
    this.gl.uniform4f(location, red, green, blue, 1);
  }
}
