import type {
  CodeTextMetrics,
  TextMetricsProbe,
} from "../rendering/text/text-metrics";
import type { RenderingProbeSource } from "../rendering/probe";
import type { TileDebugSnapshot } from "../rendering/scene/tile-residency";
import type { LineWindow } from "../code-view/index";
import type { FrameLog } from "./frame-log";

interface CodeCanvasTestHook {
  textMetrics(fileId?: string): TextMetricsProbe;
  cellColors(fileId?: string): { cluster: string; colorIndex: number }[][];
  tileDebug(fileId?: string): TileDebugSnapshot;
  frameLog(): ReturnType<FrameLog["snapshot"]>;
  widgetRects(): readonly {
    filePath: string;
    rect: { x: number; y: number; width: number; height: number };
  }[];
  setCamera(x: number, y: number, scale: number): void;
}

declare global {
  interface Window {
    __codeCanvasTest?: CodeCanvasTestHook;
  }
}

interface DevProbeOptions {
  readonly canvas: HTMLCanvasElement;
  readonly metrics: Pick<CodeTextMetrics, "lineNumberGutter">;
  readonly source: () => RenderingProbeSource | undefined;
  readonly firstFileId: () => string | undefined;
  readonly frameLog: () => ReturnType<FrameLog["snapshot"]>;
  readonly widgetRects: CodeCanvasTestHook["widgetRects"];
  readonly setCamera: CodeCanvasTestHook["setCamera"];
}

export interface DevProbe {
  sync(): void;
}

export function installDevProbe(options: DevProbeOptions): DevProbe {
  const hook: CodeCanvasTestHook = {
    textMetrics: (fileId) => textMetrics(options, fileId),
    cellColors: (fileId) => cellColors(options, fileId),
    tileDebug: (fileId) => tileDebug(options, fileId),
    frameLog: options.frameLog,
    widgetRects: options.widgetRects,
    setCamera: options.setCamera,
  };
  window.__codeCanvasTest = hook;
  const probe = {
    sync: (): void => {
      syncAttributes(options);
    },
  };
  probe.sync();
  return probe;
}

function syncAttributes(options: DevProbeOptions): void {
  const source = options.source();
  const fileId = options.firstFileId();
  const lineWindow = fileId ? source?.lineWindows.get(fileId) : undefined;
  setAttribute(
    options.canvas,
    "data-content-version",
    lineWindow?.contentVersion,
  );
  setAttribute(
    options.canvas,
    "data-highlighted",
    lineWindow?.highlighted ?? false,
  );
}

function textMetrics(
  options: DevProbeOptions,
  fileId: string | undefined,
): TextMetricsProbe {
  const source = requireSource(options);
  const targetFileId = fileId ?? options.firstFileId();
  const lineWindow = targetFileId
    ? source.lineWindows.get(targetFileId)
    : undefined;
  return {
    baseline: source.baseline,
    lines: visibleCells(lineWindow, options.metrics).map((line) =>
      line.map(({ cluster, x }) => ({ cluster, x })),
    ),
  };
}

function cellColors(
  options: DevProbeOptions,
  fileId: string | undefined,
): { cluster: string; colorIndex: number }[][] {
  const source = requireSource(options);
  const targetFileId = fileId ?? options.firstFileId();
  const lineWindow = targetFileId
    ? source.lineWindows.get(targetFileId)
    : undefined;
  return visibleCells(lineWindow, options.metrics).map((line) =>
    line.map(({ cluster, colorIndex }) => ({ cluster, colorIndex })),
  );
}

function tileDebug(
  options: DevProbeOptions,
  fileId: string | undefined,
): TileDebugSnapshot {
  return requireSource(options).tileDebug(fileId ?? options.firstFileId());
}

function requireSource(options: DevProbeOptions): RenderingProbeSource {
  const source = options.source();
  if (!source) throw new Error("Renderer is not ready");
  return source;
}

interface ProbeCell {
  readonly cluster: string;
  readonly x: number;
  readonly colorIndex: number;
}

function visibleCells(
  lineWindow: LineWindow | undefined,
  metrics: Pick<CodeTextMetrics, "lineNumberGutter">,
): ProbeCell[][] {
  if (!lineWindow) return [];
  const gutterWidth = metrics.lineNumberGutter.codeLeft(lineWindow.lineCount);
  const lines: ProbeCell[][] = Array.from(
    { length: Math.min(60, lineWindow.lineCount) },
    () => [],
  );
  for (let line = 0; line < lines.length; line += 1) {
    const windowLine = line - lineWindow.firstLine;
    if (windowLine < 0 || windowLine >= lineWindow.lines.length) continue;
    const sourceLine = lineWindow.lines[windowLine] ?? "";
    const cells: ProbeCell[] = [];
    const startCell = lineWindow.lineCellOffsets[windowLine] ?? 0;
    const endCell = lineWindow.lineCellOffsets[windowLine + 1] ?? startCell;
    for (let cell = startCell; cell < endCell; cell += 1) {
      const start = lineWindow.cellStarts[cell] ?? 0;
      const end = lineWindow.cellEnds[cell] ?? start;
      cells.push({
        cluster: sourceLine.slice(start, end),
        x: gutterWidth + (lineWindow.cellXs[cell] ?? 0),
        colorIndex: lineWindow.cellColors[cell] ?? 0,
      });
    }
    lines[line] = cells;
  }
  return lines;
}

function setAttribute(
  canvas: HTMLCanvasElement,
  name: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined) return;
  const next = String(value);
  if (canvas.getAttribute(name) !== next) canvas.setAttribute(name, next);
}
