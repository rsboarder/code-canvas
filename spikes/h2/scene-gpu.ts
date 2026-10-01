import {
  ATLAS_INSTANCE_FLOATS,
  BACKGROUND,
  DPR,
  TILE_ATLAS_SIZE,
  TILE_DEVICE_SIZE,
  countNonBackgroundPixels,
  required,
  webGlErrorName,
  type Tile,
} from "./model";
import { VIEW_HEIGHT, VIEW_WIDTH } from "./pure";
import {
  ATLAS_INSTANCED_VERTEX,
  CLIPPED_TEXT_FRAGMENT,
  createProgram,
  RECT_FRAGMENT,
  RECT_VERTEX,
  TEXTURE_FRAGMENT,
  TEXTURE_VERTEX,
} from "./gpu-shaders";

interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

// Looked up once, at program creation, instead of once per widget per frame
// (drawAtlasWidget) or once per frame (beginAtlasInstancedDraw) — a
// WebGLUniformLocation is stable for the program's lifetime.
interface AtlasUniforms {
  readonly resolution: WebGLUniformLocation | null;
  readonly camera: WebGLUniformLocation | null;
  readonly lineHeight: WebGLUniformLocation | null;
  readonly baseline: WebGLUniformLocation | null;
  readonly palette: WebGLUniformLocation | null;
  readonly atlasTexture: WebGLUniformLocation | null;
  readonly slotTable: WebGLUniformLocation | null;
  readonly straightTexture: WebGLUniformLocation | null;
  readonly premultiplied: WebGLUniformLocation | null;
  readonly widgetOrigin: WebGLUniformLocation | null;
  readonly widgetScroll: WebGLUniformLocation | null;
  readonly widgetClipRect: WebGLUniformLocation | null;
}

export class SceneGpu {
  readonly gl: WebGL2RenderingContext;
  readonly textureAtlas: WebGLTexture;
  private readonly rectProgram: WebGLProgram;
  private readonly textureProgram: WebGLProgram;
  private readonly atlasInstancedProgram: WebGLProgram;
  private readonly atlasUniforms: AtlasUniforms;
  private readonly buffer: WebGLBuffer;
  private readonly quadCornerBuffer: WebGLBuffer;
  private readonly validationMode: boolean;
  private readonly webglLint: { disable: () => void } | null;
  private readonly timerExtension: TimerQueryExtension | null;
  private readonly pendingQueries: WebGLQuery[] = [];
  private readonly gpuTimes: number[] = [];
  private activeQuery: WebGLQuery | undefined;
  private validationPixels = 0;
  private validationGlError: string | null = null;
  // The palette never changes across the renderer's lifetime (COLOR_RGB is a
  // fixed constant), so it is uploaded once, not reallocated/reuploaded
  // every beginAtlasInstancedDraw call.
  private paletteUploaded = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: { readonly validation: boolean; readonly timing: boolean },
  ) {
    this.validationMode = options.validation;
    canvas.width = VIEW_WIDTH * DPR;
    canvas.height = VIEW_HEIGHT * DPR;
    this.gl = required(
      canvas.getContext("webgl2", {
        antialias: false,
        alpha: false,
        preserveDrawingBuffer: options.validation,
      }),
      "WebGL2",
    );
    this.timerExtension = options.timing
      ? (this.gl.getExtension(
          "EXT_disjoint_timer_query_webgl2",
        ) as TimerQueryExtension | null)
      : null;
    if (options.validation) {
      const lint = this.gl.getExtension("GMAN_debug_helper") as {
        setConfiguration: (configuration: {
          readonly maxDrawCalls: number;
          readonly throwOnError: boolean;
        }) => void;
        disable: () => void;
      } | null;
      if (!lint)
        throw new Error("VALIDATION FAILED: webgl-lint extension unavailable");
      lint.setConfiguration({ maxDrawCalls: 10_000, throwOnError: true });
      this.webglLint = lint;
    } else {
      this.webglLint = null;
    }
    this.rectProgram = createProgram(this.gl, RECT_VERTEX, RECT_FRAGMENT);
    this.textureProgram = createProgram(
      this.gl,
      TEXTURE_VERTEX,
      TEXTURE_FRAGMENT,
    );
    this.atlasInstancedProgram = createProgram(
      this.gl,
      ATLAS_INSTANCED_VERTEX,
      CLIPPED_TEXT_FRAGMENT,
    );
    this.atlasUniforms = {
      resolution: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "resolution",
      ),
      camera: this.gl.getUniformLocation(this.atlasInstancedProgram, "camera"),
      lineHeight: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "lineHeight",
      ),
      baseline: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "baseline",
      ),
      palette: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "palette",
      ),
      atlasTexture: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "atlas",
      ),
      slotTable: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "slotTable",
      ),
      straightTexture: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "straightTexture",
      ),
      premultiplied: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "premultiplied",
      ),
      widgetOrigin: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "widgetOrigin",
      ),
      widgetScroll: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "widgetScroll",
      ),
      widgetClipRect: this.gl.getUniformLocation(
        this.atlasInstancedProgram,
        "widgetClipRect",
      ),
    };
    this.buffer = required(this.gl.createBuffer(), "the scene buffer");
    // One static unit quad (4 corners), shared by every glyph instance across
    // every widget; drawn via TRIANGLE_STRIP with vertexAttribDivisor 0 while
    // the compact per-glyph record advances per instance (divisor 1).
    this.quadCornerBuffer = required(
      this.gl.createBuffer(),
      "the atlas quad corner buffer",
    );
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quadCornerBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      this.gl.STATIC_DRAW,
    );
    this.textureAtlas = required(
      this.gl.createTexture(),
      "the tile texture atlas",
    );
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.textureAtlas);
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MIN_FILTER,
      this.gl.LINEAR,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MAG_FILTER,
      this.gl.LINEAR,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_S,
      this.gl.CLAMP_TO_EDGE,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_T,
      this.gl.CLAMP_TO_EDGE,
    );
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      TILE_ATLAS_SIZE,
      TILE_ATLAS_SIZE,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      null,
    );
  }

  begin(cameraX: number, cameraY: number, zoom: number): void {
    const gl = this.gl;
    this.beginGpuTimer();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(this.rectProgram);
    this.setCamera(this.rectProgram, cameraX, cameraY, zoom);
  }

  assertFirstFrameClean(): void {
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR)
      throw new Error(
        `H2 first-frame WebGL check failed: ${webGlErrorName(this.gl, error)}`,
      );
  }

  endFrame(): void {
    if (this.activeQuery) {
      this.gl.endQuery(this.timerExtension?.TIME_ELAPSED_EXT ?? 0);
      this.pendingQueries.push(this.activeQuery);
      this.activeQuery = undefined;
    }
    this.collectGpuTimes();
    if (!this.validationMode) return;
    const pixels = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    this.gl.readPixels(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      pixels,
    );
    this.validationPixels = countNonBackgroundPixels(pixels);
    this.validationGlError =
      this.gl.getError() === this.gl.NO_ERROR
        ? null
        : "VALIDATION FAILED: WebGL error after readPixels";
  }

  resetMetrics(): void {
    this.gpuTimes.length = 0;
    this.validationPixels = 0;
    this.validationGlError = null;
  }

  getValidation(): {
    readonly nonBackgroundPixels: number;
    readonly glError: string | null;
  } {
    return {
      nonBackgroundPixels: this.validationPixels,
      glError: this.validationGlError,
    };
  }

  disableValidationLint(): void {
    this.webglLint?.disable();
  }

  getGpuTimes(): readonly number[] {
    return this.gpuTimes;
  }

  hasGpuTimer(): boolean {
    return this.timerExtension !== null;
  }

  private beginGpuTimer(): void {
    if (!this.timerExtension || this.activeQuery) return;
    const query = required(this.gl.createQuery(), "a GPU timer query");
    this.activeQuery = query;
    this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
  }

  private collectGpuTimes(): void {
    if (!this.timerExtension) return;
    if (this.gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT)) {
      for (const query of this.pendingQueries) this.gl.deleteQuery(query);
      this.pendingQueries.length = 0;
      return;
    }
    while (this.pendingQueries.length > 0) {
      const query = this.pendingQueries[0];
      if (!query) break;
      const available = this.gl.getQueryParameter(
        query,
        this.gl.QUERY_RESULT_AVAILABLE,
      ) as boolean;
      if (!available) break;
      const nanoseconds = this.gl.getQueryParameter(
        query,
        this.gl.QUERY_RESULT,
      ) as number;
      this.gpuTimes.push(nanoseconds / 1_000_000);
      this.gl.deleteQuery(query);
      this.pendingQueries.shift();
    }
  }

  drawRects(
    rects: readonly {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly color: readonly [number, number, number];
    }[],
  ): void {
    if (rects.length === 0) return;
    const vertices: number[] = [];
    for (const rect of rects) {
      const [red, green, blue] = rect.color;
      const values = [
        rect.x,
        rect.y,
        red,
        green,
        blue,
        rect.x + rect.width,
        rect.y,
        red,
        green,
        blue,
        rect.x,
        rect.y + rect.height,
        red,
        green,
        blue,
        rect.x + rect.width,
        rect.y,
        red,
        green,
        blue,
        rect.x + rect.width,
        rect.y + rect.height,
        red,
        green,
        blue,
        rect.x,
        rect.y + rect.height,
        red,
        green,
        blue,
      ];
      vertices.push(...values);
    }
    const gl = this.gl;
    gl.useProgram(this.rectProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
    this.bindAttributes(this.rectProgram, 20, 0, 8);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 5);
  }

  drawTexture(
    tiles: readonly Tile[],
    cameraX: number,
    cameraY: number,
    zoom: number,
  ): void {
    const vertices: number[] = [];
    for (const tile of tiles) {
      if (!tile.ready) continue;
      // A tile clamped at a widget edge rastered assuming the full,
      // unclamped grid-cell size (model.ts Tile.uvWidth/uvHeight), so only
      // that fraction of the TILE_DEVICE_SIZE square is valid content; the
      // quad is tile.width/height (already clamped), so sampling the full
      // slot here would squeeze that larger raster into the smaller quad.
      const u0 = tile.slotX / TILE_ATLAS_SIZE;
      const v0 = tile.slotY / TILE_ATLAS_SIZE;
      const u1 =
        (tile.slotX + TILE_DEVICE_SIZE * tile.uvWidth) / TILE_ATLAS_SIZE;
      const v1 =
        (tile.slotY + TILE_DEVICE_SIZE * tile.uvHeight) / TILE_ATLAS_SIZE;
      vertices.push(
        tile.worldX,
        tile.worldY,
        u0,
        v0,
        tile.worldX + tile.width,
        tile.worldY,
        u1,
        v0,
        tile.worldX,
        tile.worldY + tile.height,
        u0,
        v1,
        tile.worldX + tile.width,
        tile.worldY,
        u1,
        v0,
        tile.worldX + tile.width,
        tile.worldY + tile.height,
        u1,
        v1,
        tile.worldX,
        tile.worldY + tile.height,
        u0,
        v1,
      );
    }
    if (vertices.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.textureProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
    this.bindAttributes(this.textureProgram, 16, 0, 8);
    this.setCamera(this.textureProgram, cameraX, cameraY, zoom);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textureAtlas);
    gl.uniform1i(
      gl.getUniformLocation(this.textureProgram, "textureSampler"),
      0,
    );
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 4);
  }

  // Each widget's glyph instance buffer is its own WebGLBuffer object (never
  // a shared one): a build/upload for widget A can then never contend with a
  // draw call still reading widget B's data on the same buffer object, which
  // was the measured density cost (bufferSubData into a shared, in-use
  // buffer during the gesture, see docs/spikes/h2.md). A widget's buffer is
  // written exactly once, with bufferData (never bufferSubData) — re-issuing
  // bufferData on an existing buffer re-specifies its store, which the
  // driver is free to serve from freshly allocated backing memory instead of
  // blocking on in-flight reads of the old one (the same "orphaning" idiom,
  // without a second buffer object).
  //
  // Attribute state (the shared quad corner + this widget's own instance
  // buffer) is captured once, here, into the widget's own VAO — not
  // re-enabled/re-pointed every frame in drawAtlasWidget. This is also what
  // keeps the rect/texture passes' default VAO clean: validation caught
  // drawArrays(TRIANGLES) failing with "no buffer is bound to enabled
  // attribute" because the earlier per-frame enableVertexAttribArray calls
  // on the default VAO were never paired with a disable, so attributes
  // 1..ATLAS_INSTANCE_FLOATS stayed enabled there pointing at buffers that
  // reset() later deleted. A VAO isolates that state per widget entirely;
  // the default VAO (rect/texture) never has those attributes touched.
  createAtlasWidgetBuffer(data: Float32Array): {
    readonly buffer: WebGLBuffer;
    readonly vao: WebGLVertexArrayObject;
    readonly uploadMs: number;
  } {
    const gl = this.gl;
    const buffer = required(gl.createBuffer(), "a widget atlas buffer");
    const start = performance.now();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const uploadMs = performance.now() - start;
    const vao = required(gl.createVertexArray(), "a widget atlas VAO");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadCornerBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const strideBytes = ATLAS_INSTANCE_FLOATS * 4;
    for (let index = 0; index < ATLAS_INSTANCE_FLOATS; index += 1) {
      gl.enableVertexAttribArray(1 + index);
      gl.vertexAttribPointer(
        1 + index,
        1,
        gl.FLOAT,
        false,
        strideBytes,
        index * 4,
      );
      gl.vertexAttribDivisor(1 + index, 1);
    }
    gl.bindVertexArray(null);
    return { buffer, vao, uploadMs };
  }

  deleteAtlasWidgetBuffer(
    buffer: WebGLBuffer,
    vao: WebGLVertexArrayObject,
  ): void {
    this.gl.deleteVertexArray(vao);
    this.gl.deleteBuffer(buffer);
  }

  // Per-slot glyph geometry (local offset + quad size) and UV rect, indexed
  // by atlas slot in the vertex shader via texelFetch (D6: "a slot table in
  // a uniform/data texture"); rebuilt only when a raster size's atlas is
  // (re)built, never per frame or per widget. Row 0 is geometry, row 1 is UV.
  createAtlasSlotTexture(data: Float32Array, slotCount: number): WebGLTexture {
    const gl = this.gl;
    const texture = required(gl.createTexture(), "an atlas slot table");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      slotCount,
      2,
      0,
      gl.RGBA,
      gl.FLOAT,
      data,
    );
    return texture;
  }

  // Frame-constant state (program, camera, lineHeight/baseline, slot/glyph
  // textures) set once per frame from cached uniform locations (atlasUniforms,
  // looked up once at program creation); drawAtlasWidget then only binds the
  // one widget's own VAO and sets its own uniforms (origin, scroll, clip
  // rect) — scrolling only ever changes the latter, never GL buffer state.
  beginAtlasInstancedDraw(
    cameraX: number,
    cameraY: number,
    zoom: number,
    lineHeight: number,
    baseline: number,
    palette: readonly (readonly [number, number, number])[],
    slotTexture: WebGLTexture,
    glyphTexture: WebGLTexture,
  ): void {
    const gl = this.gl;
    const uniforms = this.atlasUniforms;
    gl.useProgram(this.atlasInstancedProgram);
    gl.uniform2f(uniforms.resolution, this.canvas.width, this.canvas.height);
    gl.uniform4f(uniforms.camera, cameraX, cameraY, zoom * DPR, zoom * DPR);
    gl.uniform1f(uniforms.lineHeight, lineHeight);
    gl.uniform1f(uniforms.baseline, baseline);
    if (!this.paletteUploaded) {
      const paletteFlat = new Float32Array(palette.length * 3);
      palette.forEach((color, index) => {
        paletteFlat[index * 3] = color[0];
        paletteFlat[index * 3 + 1] = color[1];
        paletteFlat[index * 3 + 2] = color[2];
      });
      gl.uniform3fv(uniforms.palette, paletteFlat);
      this.paletteUploaded = true;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
    gl.uniform1i(uniforms.atlasTexture, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, slotTexture);
    gl.uniform1i(uniforms.slotTable, 1);
    gl.uniform1i(uniforms.straightTexture, 1);
    gl.uniform1i(uniforms.premultiplied, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  drawAtlasWidget(
    vao: WebGLVertexArrayObject,
    instanceCount: number,
    widgetOriginX: number,
    widgetOriginY: number,
    widgetScroll: number,
    clipRect: readonly [number, number, number, number],
  ): void {
    if (instanceCount === 0) return;
    const gl = this.gl;
    const uniforms = this.atlasUniforms;
    gl.bindVertexArray(vao);
    gl.uniform2f(uniforms.widgetOrigin, widgetOriginX, widgetOriginY);
    gl.uniform1f(uniforms.widgetScroll, widgetScroll);
    gl.uniform4f(
      uniforms.widgetClipRect,
      clipRect[0],
      clipRect[1],
      clipRect[2],
      clipRect[3],
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
  }

  endAtlasInstancedDraw(): void {
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  uploadTile(tile: Tile, source: TexImageSource): number {
    const gl = this.gl;
    const start = performance.now();
    gl.bindTexture(gl.TEXTURE_2D, this.textureAtlas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      tile.slotX,
      tile.slotY,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    );
    return performance.now() - start;
  }

  private setCamera(
    program: WebGLProgram,
    cameraX: number,
    cameraY: number,
    zoom: number,
  ): void {
    this.gl.uniform2f(
      this.gl.getUniformLocation(program, "resolution"),
      this.canvas.width,
      this.canvas.height,
    );
    this.gl.uniform4f(
      this.gl.getUniformLocation(program, "camera"),
      cameraX,
      cameraY,
      zoom * DPR,
      zoom * DPR,
    );
  }

  private bindAttributes(
    program: WebGLProgram,
    strideBytes: number,
    positionOffset: number,
    secondOffset: number,
  ): void {
    const position = this.gl.getAttribLocation(program, "position");
    if (position >= 0) {
      this.gl.enableVertexAttribArray(position);
      this.gl.vertexAttribPointer(
        position,
        2,
        this.gl.FLOAT,
        false,
        strideBytes,
        positionOffset,
      );
    }
    const positionUv = this.gl.getAttribLocation(program, "positionUv");
    if (positionUv >= 0) {
      this.gl.enableVertexAttribArray(positionUv);
      this.gl.vertexAttribPointer(
        positionUv,
        4,
        this.gl.FLOAT,
        false,
        strideBytes,
        positionOffset,
      );
    }
    const color = this.gl.getAttribLocation(program, "inputColor");
    const colorIn =
      color >= 0 ? color : this.gl.getAttribLocation(program, "colorIn");
    if (colorIn >= 0) {
      this.gl.enableVertexAttribArray(colorIn);
      this.gl.vertexAttribPointer(
        colorIn,
        3,
        this.gl.FLOAT,
        false,
        strideBytes,
        secondOffset,
      );
    }
  }
}
