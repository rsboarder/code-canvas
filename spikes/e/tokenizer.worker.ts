import { compile } from "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
import { MonarchTokenizer } from "monaco-editor/editor/standalone/common/monarch/monarchLexer.js";
import { language } from "monaco-editor/languages/definitions/typescript/typescript.js";
import type {
  WorkerFailure,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

const tokenizer = new MonarchTokenizer(
  undefined,
  undefined,
  "typescript",
  compile("typescript", language),
  {
    getValue: () => 20000,
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
);

function resolveScope(scope: string, values: Record<string, number>): number {
  let candidate = scope.replace(/\.ts$/, "");
  while (candidate.length > 0) {
    const value = values[candidate];
    if (value !== undefined) return value;
    const separator = candidate.lastIndexOf(".");
    candidate = separator < 0 ? "" : candidate.slice(0, separator);
  }
  return values[""] ?? 1;
}

function tokenize(lines: string[], colorsByScope: Record<string, number>) {
  const offsets = new Uint32Array(lines.length + 1);
  const characterCount = lines.reduce((sum, line) => sum + line.length, 0);
  const colors = new Uint32Array(characterCount);
  let state = tokenizer.getInitialState();
  let offset = 0;
  lines.forEach((line, lineIndex) => {
    offsets[lineIndex] = offset;
    const result = tokenizer.tokenize(
      line,
      lineIndex < lines.length - 1,
      state,
    );
    state = result.endState;
    result.tokens.forEach((token, tokenIndex) => {
      const next = result.tokens[tokenIndex + 1]?.offset ?? line.length;
      colors.fill(
        resolveScope(token.type, colorsByScope),
        offset + token.offset,
        offset + next,
      );
    });
    offset += line.length;
  });
  offsets[lines.length] = offset;
  return { colors, offsets };
}

function buildMinimap(
  lines: string[],
  colors: Uint32Array,
  offsets: Uint32Array,
  palette: Record<string, number>,
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
    const lineStart = offsets[sourceLine] ?? 0;
    for (let column = 0; column < width; column += 1) {
      const start = Math.floor((column * line.length) / width);
      const end = Math.max(
        start + 1,
        Math.floor(((column + 1) * line.length) / width),
      );
      for (
        let character = start;
        character < Math.min(end, line.length);
        character += 1
      ) {
        if (!/\s/u.test(line[character] ?? "")) {
          bytes[row * width + column] =
            palette[String(colors[lineStart + character] ?? 0)] ?? 0;
          break;
        }
      }
    }
  }
  return { bytes, height };
}

const worker = self as unknown as {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  postMessage: (message: WorkerMessage, transfer?: Transferable[]) => void;
};

worker.onmessage = (event) => {
  const request = event.data;
  try {
    const startedAt = performance.now();
    const lines = request.text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const tokenStartedAt = performance.now();
    const tokenized = tokenize(lines, request.scopeColors);
    const minimapStartedAt = performance.now();
    const minimap = buildMinimap(
      lines,
      tokenized.colors,
      tokenized.offsets,
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
        tokenizeMs: performance.now() - tokenStartedAt,
        minimapMs: performance.now() - minimapStartedAt,
        totalMs: performance.now() - startedAt,
        lineCount: lines.length,
        characterCount: tokenized.colors.length,
      },
      colors: tokenized.colors,
      lineOffsets: tokenized.offsets,
      minimap: minimap.bytes,
      minimapHeight: minimap.height,
    };
    worker.postMessage(response, [
      response.colors.buffer,
      response.lineOffsets.buffer,
      response.minimap.buffer,
    ]);
  } catch (error) {
    const failure: WorkerFailure = {
      type: "error",
      id: request.id,
      contentVersion: request.contentVersion,
      fileId: request.fileId,
      message: error instanceof Error ? error.message : String(error),
    };
    if (error instanceof Error && error.stack) failure.stack = error.stack;
    worker.postMessage(failure);
  }
};
