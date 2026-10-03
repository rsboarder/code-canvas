const WIDTH = 256;
const HEIGHT = 512;
const FALLBACK_MAX_LAYERS = 256;

export class MinimapAtlas {
  private readonly maxLayers: number;
  private textureValue: WebGLTexture | undefined;
  private allocatedLayers = 0;
  private readonly fileToLayer = new Map<string, number>();
  private fileByLayer: (string | undefined)[] = [];
  private rowsByLayer = new Uint16Array(0);
  private readonly assignedLayers: number[] = [];
  private generationValue = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const limit: unknown = gl.getParameter(
      gl.MAX_ARRAY_TEXTURE_LAYERS,
    ) as unknown;
    this.maxLayers =
      typeof limit === "number" ? Math.max(1, limit) : FALLBACK_MAX_LAYERS;
  }

  get generation(): number {
    return this.generationValue;
  }

  get texture(): WebGLTexture | undefined {
    return this.textureValue;
  }

  get assignedCount(): number {
    return this.assignedLayers.length;
  }

  fileIdAt(index: number): string | undefined {
    const layer = this.assignedLayers[index];
    return layer === undefined ? undefined : this.fileByLayer[layer];
  }

  layerAt(index: number): number {
    return this.assignedLayers[index] ?? -1;
  }

  rowsAt(index: number): number {
    const layer = this.assignedLayers[index];
    return layer === undefined ? 0 : (this.rowsByLayer[layer] ?? 0);
  }

  setFiles(fileIds: readonly string[]): void {
    if (this.shouldRecreate(fileIds.length)) {
      this.allocate(this.nextLayerCount(fileIds.length));
    } else {
      this.releaseMissing(fileIds);
    }
    this.assignNew(fileIds);
    this.rebuildAssignedLayers();
    if (fileIds.length > this.maxLayers) {
      console.error(
        `MinimapAtlas capacity exceeded: drawing ${String(this.maxLayers)} of ${String(fileIds.length)} files.`,
      );
    }
    this.generationValue += 1;
  }

  upload(fileId: string, bytes: Uint8Array, height: number): void {
    const layer = this.fileToLayer.get(fileId);
    const texture = this.textureValue;
    if (layer === undefined || texture === undefined) return;
    const rows = Math.min(HEIGHT, Math.max(1, height));
    this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, texture);
    this.gl.texSubImage3D(
      this.gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      layer,
      WIDTH,
      rows,
      1,
      this.gl.RED,
      this.gl.UNSIGNED_BYTE,
      bytes,
    );
    this.rowsByLayer[layer] = rows;
    this.generationValue += 1;
  }

  private shouldRecreate(fileCount: number): boolean {
    return (
      fileCount > this.allocatedLayers && this.allocatedLayers < this.maxLayers
    );
  }

  private nextLayerCount(fileCount: number): number {
    return Math.min(
      this.maxLayers,
      Math.max(64, fileCount, this.allocatedLayers * 2),
    );
  }

  private allocate(layerCount: number): void {
    const oldTexture = this.textureValue;
    this.textureValue = this.createTexture(layerCount);
    if (oldTexture !== undefined) this.gl.deleteTexture(oldTexture);
    this.allocatedLayers = layerCount;
    this.fileToLayer.clear();
    this.fileByLayer = new Array<string | undefined>(layerCount);
    this.rowsByLayer = new Uint16Array(layerCount);
    this.assignedLayers.length = 0;
  }

  private createTexture(layerCount: number): WebGLTexture {
    const texture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, texture);
    this.gl.texStorage3D(
      this.gl.TEXTURE_2D_ARRAY,
      1,
      this.gl.R8,
      WIDTH,
      HEIGHT,
      layerCount,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D_ARRAY,
      this.gl.TEXTURE_MIN_FILTER,
      this.gl.NEAREST,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D_ARRAY,
      this.gl.TEXTURE_MAG_FILTER,
      this.gl.NEAREST,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D_ARRAY,
      this.gl.TEXTURE_WRAP_S,
      this.gl.CLAMP_TO_EDGE,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D_ARRAY,
      this.gl.TEXTURE_WRAP_T,
      this.gl.CLAMP_TO_EDGE,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D_ARRAY,
      this.gl.TEXTURE_WRAP_R,
      this.gl.CLAMP_TO_EDGE,
    );
    return texture;
  }

  private releaseMissing(fileIds: readonly string[]): void {
    const listed = new Set(fileIds);
    for (const [fileId, layer] of this.fileToLayer) {
      if (listed.has(fileId)) continue;
      this.fileToLayer.delete(fileId);
      this.fileByLayer[layer] = undefined;
      this.rowsByLayer[layer] = 0;
    }
  }

  private assignNew(fileIds: readonly string[]): void {
    for (const fileId of fileIds) {
      if (this.fileToLayer.has(fileId)) continue;
      const layer = this.findFreeLayer();
      if (layer < 0) continue;
      this.fileToLayer.set(fileId, layer);
      this.fileByLayer[layer] = fileId;
      this.rowsByLayer[layer] = 0;
    }
  }

  private findFreeLayer(): number {
    for (let layer = 0; layer < this.allocatedLayers; layer += 1) {
      if (this.fileByLayer[layer] === undefined) return layer;
    }
    return -1;
  }

  private rebuildAssignedLayers(): void {
    this.assignedLayers.length = 0;
    for (let layer = 0; layer < this.allocatedLayers; layer += 1) {
      if (this.fileByLayer[layer] !== undefined)
        this.assignedLayers.push(layer);
    }
  }
}
