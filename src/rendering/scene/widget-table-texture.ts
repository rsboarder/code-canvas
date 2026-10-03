import { MAX_WIDGET_ROWS, WidgetTable } from "./widget-table";

export class WidgetTableTexture {
  readonly texture: WebGLTexture;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const texture = gl.createTexture();
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 2, MAX_WIDGET_ROWS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  upload(table: WidgetTable): boolean {
    if (!table.hasDirtyRows) return false;
    const start = table.dirtyRowStart ?? 0;
    const end = table.dirtyRowEndExclusive ?? start;
    const rowCount = end - start;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      0,
      start,
      2,
      rowCount,
      this.gl.RGBA,
      this.gl.FLOAT,
      table.values,
      start * 8,
    );
    table.clearDirtyRange();
    return true;
  }

  uploadAll(table: WidgetTable): void {
    if (table.rowCount === 0) return;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      0,
      0,
      2,
      table.rowCount,
      this.gl.RGBA,
      this.gl.FLOAT,
      table.values,
      0,
    );
    table.clearDirtyRange();
  }
}
