import { deflateSync } from "node:zlib";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import onigurumaNamespace from "vscode-oniguruma";
import vscodeTextmateNamespace from "vscode-textmate";
import type {
  Registry as RegistryClass,
  IGrammar,
  IRawGrammar,
  IRawTheme,
  StateStack,
} from "vscode-textmate";

const { Registry } = vscodeTextmateNamespace as unknown as {
  Registry: typeof RegistryClass;
};
const { OnigScanner, OnigString, loadWASM } = onigurumaNamespace as unknown as {
  OnigScanner: new (
    patterns: string[],
  ) => InstanceType<typeof import("vscode-oniguruma").OnigScanner>;
  OnigString: new (
    value: string,
  ) => InstanceType<typeof import("vscode-oniguruma").OnigString>;
  loadWASM: typeof import("vscode-oniguruma").loadWASM;
};
import tsxGrammar from "tm-grammars/grammars/tsx.json" with { type: "json" };
import darkPlus from "tm-themes/themes/dark-plus.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const MINIMAP_WIDTH = 256;
const MINIMAP_MAX_HEIGHT = 512;

function metadataForeground(metadata: number): number {
  return (metadata >>> 15) & 0x1ff;
}

function packLineRuns(
  lines: string[],
  grammar: IGrammar,
): { runs: Uint32Array; lineRunOffsets: Uint32Array } {
  const packed: number[] = [];
  const lineRunOffsets = new Uint32Array(lines.length + 1);
  let ruleStack: StateStack | null = null;
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

// Same rule as spikes/d2/tokenizer.worker.ts buildMinimap: 256 columns,
// min(lines, 512) rows, first non-whitespace token color per column.
function buildMinimap(
  lines: string[],
  runs: Uint32Array,
  lineRunOffsets: Uint32Array,
  colorMap: string[],
): { rgb: Uint8Array; width: number; height: number } {
  const height = Math.min(lines.length, MINIMAP_MAX_HEIGHT);
  const rgb = new Uint8Array(MINIMAP_WIDTH * height * 3);
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
      let hex = "#000000";
      for (
        let character = start;
        character < Math.min(end, source.length);
        character += 1
      ) {
        if (!/\s/u.test(source[character] ?? "")) {
          const colorId = colorAt(runs, lineRunOffsets, sourceLine, character);
          hex = (colorMap[colorId] ?? "#000000").toUpperCase();
          break;
        }
      }
      const pixel = (row * MINIMAP_WIDTH + column) * 3;
      rgb[pixel] = parseInt(hex.slice(1, 3), 16);
      rgb[pixel + 1] = parseInt(hex.slice(3, 5), 16);
      rgb[pixel + 2] = parseInt(hex.slice(5, 7), 16);
    }
  }
  return { rgb, width: MINIMAP_WIDTH, height };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(data.byteLength, 0);
  const crcInput = Buffer.concat([typeBytes, Buffer.from(data)]);
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lengthBytes, typeBytes, Buffer.from(data), crcBytes]);
}

// Minimal PNG encoder (8-bit RGB, no interlace, no dependency) — offline
// verification only, not spike deliverable code.
function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(2, 9);
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);
  const ihdr = chunk("IHDR", ihdrData);

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + row * stride, stride).copy(
      raw,
      row * (stride + 1) + 1,
    );
  }
  const idat = chunk("IDAT", deflateSync(raw));
  const iend = chunk("IEND", new Uint8Array(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

async function main(): Promise<void> {
  const wasmBytes = await readFile(
    join(repoRoot, "node_modules/vscode-oniguruma/release/onig.wasm"),
  );
  await loadWASM(wasmBytes.buffer);

  const rawGrammars = new Map<string, IRawGrammar>([
    ["source.tsx", tsxGrammar as unknown as IRawGrammar],
  ]);
  const darkPlusTheme = darkPlus as unknown as {
    name?: string;
    colors?: Record<string, string>;
    tokenColors?: {
      scope?: string | string[];
      settings: {
        fontStyle?: string;
        foreground?: string;
        background?: string;
      };
    }[];
  };
  const colors = darkPlusTheme.colors ?? {};
  const globalSetting = {
    settings: {
      ...(colors["editor.foreground"]
        ? { foreground: colors["editor.foreground"] }
        : {}),
      ...(colors["editor.background"]
        ? { background: colors["editor.background"] }
        : {}),
    },
  };
  const rawTheme: IRawTheme = {
    ...(darkPlusTheme.name ? { name: darkPlusTheme.name } : {}),
    settings: [globalSetting, ...(darkPlusTheme.tokenColors ?? [])],
  };
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
      createOnigString: (value: string) => new OnigString(value),
    }),
    theme: rawTheme,
    loadGrammar: (scopeName) =>
      Promise.resolve(rawGrammars.get(scopeName) ?? null),
  });
  registry.setTheme(rawTheme);
  const tsx = await registry.loadGrammar("source.tsx");
  if (!tsx) {
    throw new Error("tsx grammar failed to load");
  }
  const colorMap = registry.getColorMap();

  const datasetFile = join(
    repoRoot,
    "fixtures/reference-dataset/group-00/widget-000.tsx",
  );
  const text = (await readFile(datasetFile)).toString("utf8");
  let lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }
  const packed = packLineRuns(lines, tsx);
  const minimap = buildMinimap(
    lines,
    packed.runs,
    packed.lineRunOffsets,
    colorMap,
  );

  const resultsDir = join(here, "results");
  await mkdir(resultsDir, { recursive: true });
  const outputPath = join(resultsDir, "minimap-widget-000.png");
  await writeFile(
    outputPath,
    encodePng(minimap.rgb, minimap.width, minimap.height),
  );
  console.log(
    `[minimap-check] wrote ${outputPath} (${String(minimap.width)}x${String(minimap.height)}, source file lines=${String(lines.length)})`,
  );

  let nonBackgroundPixels = 0;
  const distinctColors = new Set<string>();
  for (let pixel = 0; pixel < minimap.rgb.length; pixel += 3) {
    const r = minimap.rgb[pixel] ?? 0;
    const g = minimap.rgb[pixel + 1] ?? 0;
    const b = minimap.rgb[pixel + 2] ?? 0;
    if (r !== 0 || g !== 0 || b !== 0) {
      nonBackgroundPixels += 1;
    }
    distinctColors.add(`${String(r)},${String(g)},${String(b)}`);
  }
  console.log(
    `[minimap-check] non-background pixels: ${String(nonBackgroundPixels)} / ${String(minimap.width * minimap.height)}; distinct RGB colors: ${String(distinctColors.size)}`,
  );
}

main().catch((error: unknown) => {
  console.error("[minimap-check] failed", error);
  process.exitCode = 1;
});
