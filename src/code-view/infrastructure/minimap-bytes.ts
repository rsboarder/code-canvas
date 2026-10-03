import { LineLayout, MINIMAP_LINE_METRICS } from "../domain/line-layout";

function colorAt(
  packed: Uint32Array,
  offsets: Uint32Array,
  line: number,
  offset: number,
): number {
  const start = offsets[line] ?? 0;
  const end = offsets[line + 1] ?? start;
  let color = 0;
  for (let index = start; index < end; index += 2) {
    const tokenOffset = packed[index] ?? 0;
    if (tokenOffset > offset) break;
    color = packed[index + 1] ?? color;
  }
  return color;
}

export function buildMinimap(
  lines: readonly string[],
  packed: Uint32Array,
  offsets: Uint32Array,
): Uint8Array {
  const width = 256;
  const height = Math.min(512, Math.max(1, lines.length));
  const bytes = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const sourceLine = Math.min(
      lines.length - 1,
      Math.floor((row * lines.length) / height),
    );
    const layout = new LineLayout(
      lines[sourceLine] ?? "",
      MINIMAP_LINE_METRICS,
    );
    layout.cells(0).forEach((cell) => {
      if (/\s/u.test(cell.text)) return;
      const column = Math.floor(cell.x);
      if (column < 0 || column >= width) return;
      const colorId = colorAt(packed, offsets, sourceLine, cell.utf16Offset);
      bytes[row * width + column] = Math.min(254, colorId + 1);
    });
  }
  return bytes;
}
