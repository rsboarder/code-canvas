// Encodes a tile's rasterizable cells (code glyphs and line-number digits)
// into the transferable typed arrays a raster job carries to a worker (D6
// "Raster workers"): cluster UTF-16 units are packed into one buffer, with
// per-cell offsets into it, so a cluster of any length (including a ZWJ
// emoji sequence or a surrogate pair) survives the postMessage copy without
// per-cluster string allocations on the way out.

export interface RasterCellInput {
  readonly cluster: string;
  readonly x: number;
  readonly line: number;
  readonly colorIndex: number;
}

export interface CellPlacement {
  x: number;
  line: number;
  colorIndex: number;
}

export interface EncodedRasterCells {
  readonly cellCount: number;
  readonly units: Uint16Array;
  readonly offsets: Uint32Array;
  readonly xOffsets: Float32Array;
  readonly lineIndex: Int32Array;
  readonly colorIndex: Uint8Array;
}

export class RasterCellWriter {
  private units = new Uint16Array(16);
  private offsets = new Uint32Array(17);
  private xOffsets = new Float32Array(16);
  private lineIndex = new Int32Array(16);
  private colorIndex = new Uint8Array(16);
  private unitCount = 0;
  private cellCount = 0;

  reset(): void {
    this.unitCount = 0;
    this.cellCount = 0;
  }

  appendCluster(
    source: string,
    start: number,
    end: number,
    placement: Readonly<CellPlacement>,
  ): void {
    this.ensureCellCapacity();
    this.ensureUnitCapacity(end - start);
    this.offsets[this.cellCount] = this.unitCount;
    for (let index = start; index < end; index += 1) {
      this.units[this.unitCount] = source.charCodeAt(index);
      this.unitCount += 1;
    }
    this.xOffsets[this.cellCount] = placement.x;
    this.lineIndex[this.cellCount] = placement.line;
    this.colorIndex[this.cellCount] = placement.colorIndex;
    this.cellCount += 1;
    this.offsets[this.cellCount] = this.unitCount;
  }

  finish(): EncodedRasterCells {
    return {
      cellCount: this.cellCount,
      units: this.units.slice(0, this.unitCount),
      offsets: this.offsets.slice(0, this.cellCount + 1),
      xOffsets: this.xOffsets.slice(0, this.cellCount),
      lineIndex: this.lineIndex.slice(0, this.cellCount),
      colorIndex: this.colorIndex.slice(0, this.cellCount),
    };
  }

  private ensureCellCapacity(): void {
    if (this.cellCount < this.xOffsets.length) return;
    const nextCapacity = this.xOffsets.length * 2;
    const xOffsets = new Float32Array(nextCapacity);
    const lineIndex = new Int32Array(nextCapacity);
    const colorIndex = new Uint8Array(nextCapacity);
    const offsets = new Uint32Array(nextCapacity + 1);
    xOffsets.set(this.xOffsets);
    lineIndex.set(this.lineIndex);
    colorIndex.set(this.colorIndex);
    offsets.set(this.offsets);
    this.xOffsets = xOffsets;
    this.lineIndex = lineIndex;
    this.colorIndex = colorIndex;
    this.offsets = offsets;
  }

  private ensureUnitCapacity(additionalUnits: number): void {
    const requiredCapacity = this.unitCount + additionalUnits;
    if (requiredCapacity <= this.units.length) return;
    let nextCapacity = this.units.length;
    while (nextCapacity < requiredCapacity) nextCapacity *= 2;
    const units = new Uint16Array(nextCapacity);
    units.set(this.units);
    this.units = units;
  }
}

export function encodeRasterCells(
  cells: readonly RasterCellInput[],
): EncodedRasterCells {
  const totalUnits = cells.reduce(
    (total, cell) => total + cell.cluster.length,
    0,
  );
  const units = new Uint16Array(totalUnits);
  const offsets = new Uint32Array(cells.length + 1);
  const xOffsets = new Float32Array(cells.length);
  const lineIndex = new Int32Array(cells.length);
  const colorIndex = new Uint8Array(cells.length);
  let cursor = 0;
  cells.forEach((cell, index) => {
    offsets[index] = cursor;
    for (let charIndex = 0; charIndex < cell.cluster.length; charIndex += 1) {
      units[cursor] = cell.cluster.charCodeAt(charIndex);
      cursor += 1;
    }
    xOffsets[index] = cell.x;
    lineIndex[index] = cell.line;
    colorIndex[index] = cell.colorIndex;
  });
  offsets[cells.length] = cursor;
  return {
    cellCount: cells.length,
    units,
    offsets,
    xOffsets,
    lineIndex,
    colorIndex,
  };
}

export function decodeRasterCells(
  encoded: EncodedRasterCells,
): RasterCellInput[] {
  const cells: RasterCellInput[] = [];
  for (let index = 0; index < encoded.cellCount; index += 1) {
    const start = encoded.offsets[index] ?? 0;
    const end = encoded.offsets[index + 1] ?? start;
    let cluster = "";
    for (let unit = start; unit < end; unit += 1) {
      cluster += String.fromCharCode(encoded.units[unit] ?? 0);
    }
    cells.push({
      cluster,
      x: encoded.xOffsets[index] ?? 0,
      line: encoded.lineIndex[index] ?? 0,
      colorIndex: encoded.colorIndex[index] ?? 0,
    });
  }
  return cells;
}

export function transferListFor(encoded: EncodedRasterCells): Transferable[] {
  return [
    encoded.units.buffer,
    encoded.offsets.buffer,
    encoded.xOffsets.buffer,
    encoded.lineIndex.buffer,
    encoded.colorIndex.buffer,
  ];
}

export interface RasterJob {
  readonly tileKey: string;
  readonly contentVersion: number;
  readonly rasterScale: number;
  readonly backgroundColor: string;
  readonly palette: readonly string[];
  readonly font: string;
  readonly baseline: number;
  readonly lineHeight: number;
  readonly originY: number;
  readonly outlineColor: string;
  readonly outlineWidth: number;
  readonly width: number;
  readonly height: number;
  readonly cells: EncodedRasterCells;
}

export interface RasterJobRequest {
  readonly type: "raster";
  readonly job: RasterJob;
}

export interface RasterResult {
  readonly tileKey: string;
  readonly contentVersion: number;
  readonly rasterScale: number;
  readonly bitmap: ImageBitmap;
}

export interface RasterResultMessage {
  readonly type: "rasterResult";
  readonly result: RasterResult;
}

export interface FontCheckMessage {
  readonly type: "fontCheck";
  readonly measuredNarrowAdvance: number;
}

export interface RasterWorkerErrorMessage {
  readonly type: "rasterError";
  readonly message: string;
}

export type RasterWorkerRequest = RasterJobRequest;
export type RasterWorkerResponse =
  RasterResultMessage | FontCheckMessage | RasterWorkerErrorMessage;
