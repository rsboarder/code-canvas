import { splitSourceLines } from "../../shared/domain/line-splitting";
import { LineLayout, MINIMAP_LINE_METRICS } from "../domain/line-layout";
import {
  createTextMateRuntime,
  grammarForFile,
  metadataForeground,
} from "./textmate";
import type { StateStack } from "vscode-textmate";

interface ContentRequest {
  readonly type: "contentChanged";
  readonly fileId: string;
  readonly contentVersion: number;
  readonly text: string;
}

interface WantedRequest {
  readonly type: "wanted";
  readonly fileId: string;
  readonly lineRanges: readonly {
    readonly start: number;
    readonly end: number;
  }[];
}

interface TokenResponse {
  readonly type: "tokens";
  readonly fileId: string;
  readonly contentVersion: number;
  readonly lineRange: { readonly start: number; readonly end: number };
  readonly runs: Uint32Array;
  readonly lineRunOffsets: Uint32Array;
  readonly palette: readonly string[];
  readonly minimap: Uint8Array;
  readonly minimapHeight: number;
}

const workerGlobal = self as unknown as {
  onmessage:
    ((event: MessageEvent<ContentRequest | WantedRequest>) => void) | null;
  postMessage(message: TokenResponse, transfer: Transferable[]): void;
};
let runtimePromise: ReturnType<typeof createTextMateRuntime> | undefined;

function runtime(): ReturnType<typeof createTextMateRuntime> {
  runtimePromise ??= createTextMateRuntime();
  return runtimePromise;
}

function packLines(
  lines: readonly string[],
  grammar: Awaited<ReturnType<typeof runtime>>["typescript"],
): {
  runs: Uint32Array;
  lineRunOffsets: Uint32Array;
} {
  const values: number[] = [];
  const offsets = new Uint32Array(lines.length + 1);
  let state: StateStack | null = null;
  lines.forEach((line, lineIndex) => {
    offsets[lineIndex] = values.length;
    const tokenized = grammar.tokenizeLine2(line, state);
    state = tokenized.ruleStack;
    let previous = -1;
    for (let index = 0; index < tokenized.tokens.length; index += 2) {
      const offset = tokenized.tokens[index] ?? 0;
      const color = metadataForeground(tokenized.tokens[index + 1] ?? 0);
      if (color === previous) continue;
      values.push(offset, color);
      previous = color;
    }
  });
  offsets[lines.length] = values.length;
  return { runs: new Uint32Array(values), lineRunOffsets: offsets };
}

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

function buildMinimap(
  lines: readonly string[],
  packed: Uint32Array,
  offsets: Uint32Array,
  colors: readonly string[],
): Uint8Array {
  const width = 256;
  const height = Math.min(512, Math.max(1, lines.length));
  const bytes = new Uint8Array(width * height);
  const palette = new Map<string, number>();
  colors.forEach((color, index) =>
    palette.set(color.toUpperCase(), Math.min(254, index + 1)),
  );
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

async function tokenize(request: ContentRequest): Promise<void> {
  const active = await runtime();
  const lines = splitSourceLines(request.text);
  const packed = packLines(lines, grammarForFile(active, request.fileId));
  const minimap = buildMinimap(
    lines,
    packed.runs,
    packed.lineRunOffsets,
    active.colorMap,
  );
  const response: TokenResponse = {
    type: "tokens",
    fileId: request.fileId,
    contentVersion: request.contentVersion,
    lineRange: { start: 0, end: lines.length },
    ...packed,
    palette: active.colorMap,
    minimap,
    minimapHeight: Math.min(512, Math.max(1, lines.length)),
  };
  workerGlobal.postMessage(response, [
    response.runs.buffer,
    response.lineRunOffsets.buffer,
    response.minimap.buffer,
  ]);
}

workerGlobal.onmessage = (event) => {
  if (event.data.type === "contentChanged") {
    void tokenize(event.data);
  }
};
