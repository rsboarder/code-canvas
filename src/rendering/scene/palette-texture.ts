export class PaletteTexture {
  readonly texture: WebGLTexture;
  private readonly bytes = new Uint8Array(256 * 4);

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.bytes,
    );
    this.setColor(0, "#1E1E1E");
    this.setColor(1, "#D4D4D4");
    this.upload();
  }

  update(colors: readonly string[]): void {
    this.bytes.fill(0);
    this.setColor(0, "#1E1E1E");
    colors.forEach((color, index) => {
      this.setColor(index + 1, color);
    });
    if (colors.length === 0) this.setColor(1, "#D4D4D4");
    this.upload();
  }

  private setColor(index: number, value: string): void {
    const hex = value.replace(/^#/u, "");
    const offset = index * 4;
    this.bytes[offset] = Number.parseInt(hex.slice(0, 2), 16) || 0;
    this.bytes[offset + 1] = Number.parseInt(hex.slice(2, 4), 16) || 0;
    this.bytes[offset + 2] = Number.parseInt(hex.slice(4, 6), 16) || 0;
    this.bytes[offset + 3] = 255;
  }

  private upload(): void {
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      0,
      0,
      256,
      1,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      this.bytes,
    );
  }
}
