import type {
  FallbackDocument,
  GpuUploader,
  TokenizedLines,
} from "../../code-view/index";
import { LineLayout } from "../../code-view/index";
import type { FontDefinition } from "../../shared/font";
import type { Rect } from "../../shared/geometry/geometry";
import { GlyphAtlas } from "../text/glyph-atlas";
import type {
  CodeTextMetrics,
  TextMetricsProbe,
  TextMetricsProbeLine,
} from "../text/text-metrics";
import { isWhitespaceCluster } from "../text/text-metrics";
import { GlyphPass } from "../passes/glyph-pass";
import { MinimapPass } from "../passes/minimap-pass";
import { PaletteTexture } from "./palette-texture";
import { WidgetTable } from "./widget-table";

const DEFAULT_VISIBLE_LINES = 60;

export class GpuUploaderAdapter implements GpuUploader {
  readonly atlas: GlyphAtlas;
  readonly palette: PaletteTexture;
  readonly table = new WidgetTable();
  readonly glyphPass: GlyphPass;
  readonly minimapPass: MinimapPass;
  private path = "";
  private fileId = "";
  private layout: LineLayout | undefined;
  private visibleStart = 0;
  private visibleEnd = DEFAULT_VISIBLE_LINES;

  constructor(
    gl: WebGL2RenderingContext,
    private readonly metrics: CodeTextMetrics,
    font: FontDefinition,
  ) {
    this.atlas = new GlyphAtlas(gl, font, metrics);
    this.palette = new PaletteTexture(gl);
    this.glyphPass = new GlyphPass(gl, this.atlas, this.palette, font);
    this.minimapPass = new MinimapPass(gl, this.palette, font);
  }

  setDocument(fileId: string, path: string, text: string, frame: Rect): void {
    this.fileId = fileId;
    this.path = path;
    this.layout = new LineLayout(text, this.metrics);
    this.table.setWidget(frame);
  }

  getTextMetricsProbe(): TextMetricsProbe {
    return {
      baseline: this.metrics.baseline,
      lines: visibleProbeLines(this.layout, this.visibleStart, this.visibleEnd),
    };
  }

  setVisibleRange(start: number, end: number): void {
    this.visibleStart = Math.max(0, start);
    this.visibleEnd = Math.max(this.visibleStart + 1, end);
  }

  uploadFallback(document: FallbackDocument): void {
    if (!this.isCurrent(document.fileId)) return;
    this.layout = new LineLayout(document.text, this.metrics);
    this.palette.update([]);
    this.uploadInstances(undefined);
  }

  uploadTokens(document: TokenizedLines): void {
    if (!this.isCurrent(document.fileId)) return;
    this.palette.update(document.palette);
    this.uploadInstances(document);
    if (document.minimap && document.minimapHeight) {
      this.minimapPass.upload(document.minimap, document.minimapHeight);
    }
  }

  private uploadInstances(tokens: TokenizedLines | undefined): void {
    if (!this.layout) return;
    const values: number[] = [];
    const titleCount = this.appendTitle(values);
    const margin = this.visibleEnd - this.visibleStart;
    const start = Math.max(0, this.visibleStart - margin);
    const end = Math.min(this.layout.lines.length, this.visibleEnd + margin);
    for (let line = start; line < end; line += 1) {
      const cells = this.layout.cells(line);
      cells.forEach((cell) => {
        if (cell.text === "\t") return;
        const slot = this.atlas.getSlot(cell.text, cell.advance);
        const color = tokens ? colorAt(tokens, line, cell.utf16Offset) + 1 : 1;
        values.push(0, line, cell.x, slot.index, color, 0);
      });
    }
    this.atlas.syncSlotTable();
    this.glyphPass.setInstances(new Float32Array(values), titleCount);
  }

  private appendTitle(values: number[]): number {
    const titleLayout = new LineLayout(this.path, this.metrics);
    const cells = titleLayout.cells(0);
    cells.forEach((cell) => {
      if (cell.text === "\t") return;
      const slot = this.atlas.getSlot(cell.text, cell.advance);
      values.push(0, -1.5, 16 + cell.x, slot.index, 1, 0);
    });
    return values.length / 6;
  }

  private isCurrent(fileId: string): boolean {
    return Boolean(this.layout) && fileId === this.fileId;
  }
}

function visibleProbeLines(
  layout: LineLayout | undefined,
  visibleStart: number,
  visibleEnd: number,
): TextMetricsProbeLine[][] {
  if (!layout) return [];
  const lines: TextMetricsProbeLine[][] = Array.from(
    { length: Math.min(DEFAULT_VISIBLE_LINES, layout.lines.length) },
    () => [],
  );
  const start = Math.max(0, visibleStart);
  const end = Math.min(visibleEnd, lines.length);
  for (let line = start; line < end; line += 1) {
    lines[line] = layout
      .cells(line)
      .filter((cell) => !isWhitespaceCluster(cell.text))
      .map((cell) => ({ cluster: cell.text, x: cell.x }));
  }
  return lines;
}

function colorAt(
  document: TokenizedLines,
  line: number,
  offset: number,
): number {
  const start = document.lineRunOffsets[line] ?? 0;
  const end = document.lineRunOffsets[line + 1] ?? start;
  let color = 0;
  for (let index = start; index < end; index += 2) {
    const tokenOffset = document.runs[index] ?? 0;
    if (tokenOffset > offset) break;
    color = document.runs[index + 1] ?? color;
  }
  return color;
}
