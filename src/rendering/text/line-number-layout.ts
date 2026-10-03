import { type CellPlacement, type RasterCellWriter } from "./raster-job";

const DIGITS = "0123456789";

export class LineNumberLayout {
  private readonly advances = new Float64Array(10);
  private readonly placement: CellPlacement = { x: 0, line: 0, colorIndex: 0 };

  constructor(advanceFor: (cluster: string) => number) {
    for (let digit = 0; digit < 10; digit += 1) {
      this.advances[digit] = advanceFor(DIGITS.charAt(digit));
    }
  }

  width(lineNumber: number): number {
    let total = 0;
    let remaining = lineNumber;
    for (
      let divisor = highestPowerOfTen(lineNumber);
      divisor >= 1;
      divisor = Math.floor(divisor / 10)
    ) {
      const digit = Math.floor(remaining / divisor);
      total += this.advances[digit] ?? 0;
      remaining -= digit * divisor;
    }
    return total;
  }

  write(
    writer: RasterCellWriter,
    lineNumber: number,
    start: Readonly<CellPlacement>,
  ): void {
    let remaining = lineNumber;
    let x = start.x;
    this.placement.line = start.line;
    this.placement.colorIndex = start.colorIndex;
    for (
      let divisor = highestPowerOfTen(lineNumber);
      divisor >= 1;
      divisor = Math.floor(divisor / 10)
    ) {
      const digit = Math.floor(remaining / divisor);
      this.placement.x = x;
      writer.appendCluster(DIGITS, digit, digit + 1, this.placement);
      x += this.advances[digit] ?? 0;
      remaining -= digit * divisor;
    }
  }
}

function highestPowerOfTen(lineNumber: number): number {
  let divisor = 1;
  while (divisor <= lineNumber / 10) divisor *= 10;
  return divisor;
}
