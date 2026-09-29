import {
  createTextMateRuntime,
  grammarForFile,
  metadataForeground,
} from "./textmate";
import { measureFileIncremental } from "./incremental";
import type {
  AnyWorkerRequest,
  IncrementalWorkerRequest,
  IncrementalWorkerResponse,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

const MINIMAP_WIDTH = 256;
const MINIMAP_MAX_HEIGHT = 512;
let runtimePromise:
  Promise<Awaited<ReturnType<typeof createTextMateRuntime>>> | undefined;
const workerGlobal = self as unknown as {
  onmessage: ((event: MessageEvent<AnyWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

function getRuntime(): Promise<
  Awaited<ReturnType<typeof createTextMateRuntime>>
> {
  runtimePromise ??= createTextMateRuntime();
  return runtimePromise;
}

function packLineRuns(
  lines: string[],
  grammar: Awaited<ReturnType<typeof createTextMateRuntime>>["typescript"],
): { runs: Uint32Array; lineRunOffsets: Uint32Array } {
  const packed: number[] = [];
  const lineRunOffsets = new Uint32Array(lines.length + 1);
  let ruleStack = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    lineRunOffsets[lineIndex] = packed.length;
    let previousColor: number | undefined;
    const result = grammar.tokenizeLine2(line, ruleStack);
    ruleStack = result.ruleStack;
    for (
      let tokenIndex = 0;
      tokenIndex < result.tokens.length;
      tokenIndex += 2
    ) {
      const start = result.tokens[tokenIndex] ?? 0;
      const color = metadataForeground(result.tokens[tokenIndex + 1] ?? 0);
      if (previousColor === color && packed.length >= 2) {
        continue;
      }
      packed.push(start, color);
      previousColor = color;
    }
  }
  lineRunOffsets[lines.length] = packed.length;
  return { runs: new Uint32Array(packed), lineRunOffsets };
}

function colorAt(
  runs: Uint32Array,
  lineRunOffsets: Uint32Array,
  line: number,
  offset: number,
): number {
  const start = lineRunOffsets[line] ?? 0;
  const end = lineRunOffsets[line + 1] ?? start;
  let color = 0;
  for (let index = start; index < end; index += 2) {
    const tokenStart = runs[index] ?? 0;
    if (tokenStart > offset) {
      break;
    }
    color = runs[index + 1] ?? color;
  }
  return color;
}

function buildMinimap(
  lines: string[],
  runs: Uint32Array,
  lineRunOffsets: Uint32Array,
  colorMap: string[],
): { bytes: Uint8Array; height: number; palette: string[] } {
  const height = Math.min(lines.length, MINIMAP_MAX_HEIGHT);
  const bytes = new Uint8Array(MINIMAP_WIDTH * height);
  const palette = ["#000000"];
  const colorToPalette = new Map<string, number>();
  for (let row = 0; row < height; row += 1) {
    const sourceLine = Math.min(
      lines.length - 1,
      Math.floor((row * lines.length) / height),
    );
    const source = lines[sourceLine] ?? "";
    for (let column = 0; column < MINIMAP_WIDTH; column += 1) {
      const start = Math.floor((column * source.length) / MINIMAP_WIDTH);
      const end = Math.max(
        start + 1,
        Math.floor(((column + 1) * source.length) / MINIMAP_WIDTH),
      );
      let colorId = 0;
      for (
        let character = start;
        character < Math.min(end, source.length);
        character += 1
      ) {
        if (!/\s/u.test(source[character] ?? "")) {
          colorId = colorAt(runs, lineRunOffsets, sourceLine, character);
          break;
        }
      }
      if (colorId === 0) {
        continue;
      }
      const hex = (colorMap[colorId] ?? "#000000").toUpperCase();
      let paletteIndex = colorToPalette.get(hex);
      if (paletteIndex === undefined) {
        if (palette.length >= 255) {
          throw new Error("R8 minimap palette exceeded 254 colors");
        }
        paletteIndex = palette.length;
        palette.push(hex);
        colorToPalette.set(hex, paletteIndex);
      }
      bytes[row * MINIMAP_WIDTH + column] = paletteIndex;
    }
  }
  return { bytes, height, palette };
}

function transferables(response: WorkerResponse): ArrayBuffer[] {
  return [
    response.runs.buffer as ArrayBuffer,
    response.lineRunOffsets.buffer as ArrayBuffer,
    response.minimap.buffer as ArrayBuffer,
  ];
}

async function tokenize(request: WorkerRequest): Promise<WorkerResponse> {
  const startedAt = performance.now();
  const runtimeStartedAt = performance.now();
  const runtime = await getRuntime();
  const initMs = performance.now() - runtimeStartedAt;
  const lines = request.text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const grammar = grammarForFile(runtime, request.fileId);
  const tokenizationStartedAt = performance.now();
  const packed = packLineRuns(lines, grammar);
  const tokenizeMs = performance.now() - tokenizationStartedAt;
  const minimapStartedAt = performance.now();
  const minimap = buildMinimap(
    lines,
    packed.runs,
    packed.lineRunOffsets,
    runtime.colorMap,
  );
  const response: WorkerResponse = {
    type: "result",
    id: request.id,
    contentVersion: request.contentVersion,
    fileId: request.fileId,
    timing: {
      initMs,
      tokenizeMs,
      minimapMs: performance.now() - minimapStartedAt,
      totalMs: performance.now() - startedAt,
      lineCount: lines.length,
      characterCount: lines.reduce((sum, line) => sum + line.length, 0),
    },
    runs: packed.runs,
    lineRunOffsets: packed.lineRunOffsets,
    minimap: minimap.bytes,
    minimapHeight: minimap.height,
    colorMap: runtime.colorMap,
    minimapPalette: minimap.palette,
  };
  return response;
}

async function handleIncremental(
  request: IncrementalWorkerRequest,
): Promise<IncrementalWorkerResponse> {
  const runtime = await getRuntime();
  const lines = request.text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const grammar = grammarForFile(runtime, request.fileId);
  const measurement = measureFileIncremental(request.fileId, lines, grammar);
  return {
    type: "incremental-result",
    id: request.id,
    fileId: request.fileId,
    result: {
      fileId: measurement.fileId,
      lineCount: measurement.lineCount,
      coldFirstWindowMs: measurement.coldFirstWindow.ms,
      coldFirstWindowLines: measurement.coldFirstWindow.linesTokenized,
      editAt10: measurement.editAt10,
      editAt1000: measurement.editAt1000,
      chunkTimingsMs: measurement.chunkTimings.map((chunk) => chunk.ms),
    },
  };
}

workerGlobal.onmessage = (event: MessageEvent<AnyWorkerRequest>) => {
  const request = event.data;
  if (request.type === "incremental") {
    handleIncremental(request)
      .then((response) => {
        workerGlobal.postMessage(response);
      })
      .catch((error: unknown) => {
        const failure: WorkerMessage = {
          type: "error",
          id: request.id,
          contentVersion: 0,
          fileId: request.fileId,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack
            ? { stack: error.stack }
            : {}),
        };
        workerGlobal.postMessage(failure);
      });
    return;
  }
  void tokenize(request)
    .then((response) => {
      workerGlobal.postMessage(
        response,
        request.mode === "transfer" ? transferables(response) : [],
      );
    })
    .catch((error: unknown) => {
      const failure: WorkerMessage = {
        type: "error",
        id: request.id,
        contentVersion: request.contentVersion,
        fileId: request.fileId,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack
          ? { stack: error.stack }
          : {}),
      };
      workerGlobal.postMessage(failure);
    });
};
