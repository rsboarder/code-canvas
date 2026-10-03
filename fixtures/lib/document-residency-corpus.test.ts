import { describe, expect, it } from "vitest";

import { EDGE_CASE_FILES } from "./dataset";
import {
  createLineGeometry,
  LineLayout,
} from "../../src/code-view/domain/line-layout";
import {
  DocumentResidency,
  type GpuUploader,
  type LineRange,
  type LineWindow,
  type MinimapUpload,
  type TokenizedLines,
  type Tokenizer,
} from "../../src/code-view/application/document-residency/index";

const lineMetrics = {
  narrowAdvance: 10,
  tabSize: 4,
  baseline: 15,
  lineHeight: 20,
  advanceFor: () => 10,
};

describe.each(EDGE_CASE_FILES)(
  "DocumentResidency corpus: $relativePath",
  (file) => {
    it("uploads every source line and a completed minimap", () => {
      const tokenizer = new CompleteTokenizer();
      const windows: LineWindow[] = [];
      const minimaps: MinimapUpload[] = [];
      const uploader: GpuUploader = {
        uploadLineWindow: (window) => windows.push(window),
        uploadMinimap: (minimap) => minimaps.push(minimap),
      };
      const residency = new DocumentResidency({ tokenizer, lineMetrics });

      residency.contentChanged(file.relativePath, 1, file.text);
      residency.visibleRangesChanged(
        new Map([
          [file.relativePath, [{ start: 0, end: file.expected.lineCount }]],
        ]),
      );
      residency.drain(Infinity, uploader);

      expect(windows).toHaveLength(1);
      expect(windows[0]?.lines).toEqual(file.expected.lines);
      expect(windows[0]?.highlighted).toBe(true);
      const window = windows[0];
      if (!window) throw new Error("Expected a line window");
      expectWindowCells(window, file.text);
      residency.visibleRangesChanged(new Map());
      residency.drain(Infinity, uploader);
      expect(minimaps).toHaveLength(1);
    });
  },
);

class CompleteTokenizer implements Tokenizer {
  readonly wantedCalls: string[] = [];
  private listener: ((result: TokenizedLines) => void) | undefined;

  contentChanged(fileId: string, contentVersion: number, text: string): void {
    const lines = sourceLines(text);
    const offsets = new Uint32Array(lines.length + 1);
    const runs = new Uint32Array(lines.length * 2);
    for (let index = 0; index < lines.length; index += 1) {
      offsets[index] = index * 2;
      runs[index * 2 + 1] = 1;
    }
    offsets[lines.length] = runs.length;
    this.listener?.({
      fileId,
      contentVersion,
      firstLine: 0,
      lineRange: { start: 0, end: lines.length },
      runs,
      lineRunOffsets: offsets,
      minimap: new Uint8Array([1]),
      minimapHeight: lines.length,
    });
  }

  wanted(fileId: string, lineRanges: readonly LineRange[]): void {
    this.wantedCalls.push(`${fileId}:${String(lineRanges.length)}`);
  }

  subscribe(listener: (result: TokenizedLines) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
}

function sourceLines(text: string): string[] {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return source.split(/\r\n|[\r\n]/u);
}

function expectWindowCells(window: LineWindow, text: string): void {
  const layout = new LineLayout(text, lineMetrics);
  const geometry = createLineGeometry();
  for (let lineOffset = 0; lineOffset < window.lines.length; lineOffset += 1) {
    const lineNumber = window.firstLine + lineOffset;
    layout.layoutLine(lineNumber, geometry);
    let cellIndex = window.lineCellOffsets[lineOffset] ?? 0;
    const cellEnd = window.lineCellOffsets[lineOffset + 1] ?? cellIndex;
    const line = layout.lines[lineNumber] ?? "";
    for (let cluster = 0; cluster < geometry.clusterCount; cluster += 1) {
      const start = geometry.utf16Starts[cluster] ?? 0;
      const end = geometry.utf16Starts[cluster + 1] ?? start;
      if (/^\s+$/u.test(line.slice(start, end))) continue;
      expect(window.cellStarts[cellIndex]).toBe(start);
      expect(window.cellEnds[cellIndex]).toBe(end);
      expect(window.cellXs[cellIndex]).toBeCloseTo(geometry.xs[cluster] ?? 0);
      cellIndex += 1;
    }
    expect(cellIndex).toBe(cellEnd);
  }
}
