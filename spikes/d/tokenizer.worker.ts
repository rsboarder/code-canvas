import { compile } from "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
import { MonarchTokenizer } from "monaco-editor/editor/standalone/common/monarch/monarchLexer.js";
import { language } from "monaco-editor/languages/definitions/typescript/typescript.js";
import type { WorkerRequest, WorkerResponse } from "./protocol";

const LANGUAGE_ID = "typescript";
interface WorkerGlobal {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerGlobal = self as unknown as WorkerGlobal;
const configurationService = {
  getValue: () => 20000,
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
};
const tokenizer = new MonarchTokenizer(
  undefined,
  undefined,
  LANGUAGE_ID,
  compile(LANGUAGE_ID, language),
  configurationService,
);

function resolveScope(scope: string, values: Record<string, number>): number {
  let candidate = scope.replace(/\.ts$/, "");
  while (candidate.length > 0) {
    const value = values[candidate];
    if (value !== undefined) {
      return value;
    }
    const separator = candidate.lastIndexOf(".");
    candidate = separator < 0 ? "" : candidate.slice(0, separator);
  }
  return values[""] ?? 1;
}

function tokenizeLines(
  lines: string[],
  scopeColors: Record<string, number>,
): { colors: Uint32Array; lineOffsets: Uint32Array } {
  const lineOffsets = new Uint32Array(lines.length + 1);
  let characterCount = 0;
  for (const line of lines) {
    characterCount += line.length;
  }
  const colors = new Uint32Array(characterCount);
  let state = tokenizer.getInitialState();
  let offset = 0;
  lines.forEach((line, lineIndex) => {
    lineOffsets[lineIndex] = offset;
    const result = tokenizer.tokenize(
      line,
      lineIndex < lines.length - 1,
      state,
    );
    state = result.endState;
    for (
      let tokenIndex = 0;
      tokenIndex < result.tokens.length;
      tokenIndex += 1
    ) {
      const token = result.tokens[tokenIndex];
      if (!token) {
        continue;
      }
      const nextOffset = result.tokens[tokenIndex + 1]?.offset ?? line.length;
      colors.fill(
        resolveScope(token.type, scopeColors),
        offset + token.offset,
        offset + nextOffset,
      );
    }
    offset += line.length;
  });
  lineOffsets[lines.length] = offset;
  return { colors, lineOffsets };
}

function buildMinimap(
  lines: string[],
  colors: Uint32Array,
  lineOffsets: Uint32Array,
  scopePalette: Record<string, number>,
  width: number,
  maxHeight: number,
): { bytes: Uint8Array; height: number } {
  const height = Math.min(lines.length, maxHeight);
  const bytes = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const sourceLine = Math.min(
      lines.length - 1,
      Math.floor((row * lines.length) / height),
    );
    const line = lines[sourceLine] ?? "";
    const lineStart = lineOffsets[sourceLine] ?? 0;
    for (let column = 0; column < width; column += 1) {
      const start = Math.floor((column * line.length) / width);
      const end = Math.max(
        start + 1,
        Math.floor(((column + 1) * line.length) / width),
      );
      let paletteIndex = 0;
      for (
        let character = start;
        character < Math.min(end, line.length);
        character += 1
      ) {
        if (!/\s/u.test(line[character] ?? "")) {
          const color = colors[lineStart + character] ?? 0;
          paletteIndex = scopePalette[String(color)] ?? 0;
          break;
        }
      }
      bytes[row * width + column] = paletteIndex;
    }
  }
  return { bytes, height };
}

function transferableBuffers(response: WorkerResponse): ArrayBuffer[] {
  return [
    response.colors.buffer as ArrayBuffer,
    response.lineOffsets.buffer as ArrayBuffer,
    response.minimap.buffer as ArrayBuffer,
  ];
}

workerGlobal.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const startedAt = performance.now();
    const lines = request.text.split("\n");
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
    const tokenizeStartedAt = performance.now();
    const { colors, lineOffsets } = tokenizeLines(lines, request.scopeColors);
    const tokenizeMs = performance.now() - tokenizeStartedAt;
    const minimapStartedAt = performance.now();
    const minimap = buildMinimap(
      lines,
      colors,
      lineOffsets,
      request.scopePalette,
      request.minimapWidth,
      request.minimapMaxHeight,
    );
    const response: WorkerResponse = {
      type: "result",
      id: request.id,
      contentVersion: request.contentVersion,
      fileId: request.fileId,
      sentAt: performance.now(),
      timing: {
        tokenizeMs,
        minimapMs: performance.now() - minimapStartedAt,
        totalMs: performance.now() - startedAt,
        lineCount: lines.length,
        characterCount: colors.length,
      },
      colors,
      lineOffsets,
      minimap: minimap.bytes,
      minimapHeight: minimap.height,
    };
    if (request.mode === "transfer") {
      workerGlobal.postMessage(response, transferableBuffers(response));
      return;
    }
    workerGlobal.postMessage(response);
  } catch (error) {
    const failure = {
      type: "error" as const,
      id: request.id,
      contentVersion: request.contentVersion,
      fileId: request.fileId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    workerGlobal.postMessage(failure);
  }
};
