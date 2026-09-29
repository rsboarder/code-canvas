import { readFile } from "node:fs/promises";
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

// vscode-textmate ships a UMD bundle with no "exports" map; Node's native
// ESM loader cannot statically detect its named exports (cjs-module-lexer
// fails on the webpacked UMD wrapper), unlike Vite's browser bundling.
// Destructure from the default (module.exports) object instead — this is a
// Node-only offline-script workaround, not a product code pattern.
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
import tsGrammar from "tm-grammars/grammars/typescript.json" with { type: "json" };
import tsxGrammar from "tm-grammars/grammars/tsx.json" with { type: "json" };
import darkPlus from "tm-themes/themes/dark-plus.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const onigWasmPath = join(
  repoRoot,
  "node_modules/vscode-oniguruma/release/onig.wasm",
);

const SAMPLE_TSX = `function renderWidget(plainIdentifier: string) { return <Widget value={plainIdentifier} />; }`;

function metadataForeground(metadata: number): number {
  return (metadata >>> 15) & 0x1ff;
}

function toHex(color: string | undefined): string {
  return color ? color.toUpperCase() : "#000000";
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

async function main(): Promise<void> {
  console.log(`[node-check] onig.wasm path: ${onigWasmPath}`);
  const wasmBytes = await readFile(onigWasmPath);
  console.log(`[node-check] onig.wasm bytes: ${String(wasmBytes.byteLength)}`);
  await loadWASM(wasmBytes.buffer);
  console.log("[node-check] loadWASM ok");

  const rawGrammars = new Map<string, IRawGrammar>([
    ["source.ts", tsGrammar as unknown as IRawGrammar],
    ["source.tsx", tsxGrammar as unknown as IRawGrammar],
  ]);
  // Mirrors spikes/d2/textmate.ts's DARK_PLUS_THEME construction: tm-themes
  // ships VS Code theme JSON (`tokenColors`), not vscode-textmate's
  // `IRawTheme` shape (`settings`) — this was reproduced here first as the
  // bug-finding step before the fix landed in textmate.ts (see that file's
  // comment for the full explanation).
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
  const typescript = await registry.loadGrammar("source.ts");
  const tsx = await registry.loadGrammar("source.tsx");
  if (!typescript || !tsx) {
    throw new Error("grammar failed to load");
  }
  const colorMap = registry.getColorMap();
  console.log(`[node-check] theme colorMap length: ${String(colorMap.length)}`);

  // Sample colors: JSX tag, function identifier, plain identifier.
  const sampleResult = packLineRuns([SAMPLE_TSX], tsx);
  function sampleColorFor(
    token: string,
    marker = token,
    markerOffset = 0,
  ): string {
    const offset = SAMPLE_TSX.indexOf(marker) + markerOffset;
    return toHex(
      colorMap[
        colorAt(sampleResult.runs, sampleResult.lineRunOffsets, 0, offset)
      ],
    );
  }
  const jsxTagColor = sampleColorFor("Widget", "<Widget", 1);
  const functionIdentifierColor = sampleColorFor("renderWidget");
  const plainIdentifierColor = sampleColorFor("plainIdentifier");
  console.log(
    `[node-check] jsxTag(Widget)=${jsxTagColor} functionIdentifier(renderWidget)=${functionIdentifierColor} plainIdentifier=${plainIdentifierColor}`,
  );
  console.log(
    `[node-check] jsxTagDistinctFromPlain=${String(jsxTagColor !== plainIdentifierColor)} functionDistinctFromPlain=${String(functionIdentifierColor !== plainIdentifierColor)}`,
  );

  // Tokenize one real 2000-line dataset file (lower-bound Node timing, no worker/postMessage overhead).
  const datasetFile = join(
    repoRoot,
    "fixtures/reference-dataset/group-00/widget-000.tsx",
  );
  const text = (await readFile(datasetFile)).toString("utf8");
  let lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }
  console.log(
    `[node-check] dataset file: ${datasetFile} lines=${String(lines.length)} chars=${String(text.length)}`,
  );

  const timings: number[] = [];
  let lastPacked: { runs: Uint32Array; lineRunOffsets: Uint32Array } | null =
    null;
  for (let pass = 0; pass < 5; pass += 1) {
    const startedAt = performance.now();
    lastPacked = packLineRuns(lines, tsx);
    timings.push(performance.now() - startedAt);
  }
  if (!lastPacked) {
    throw new Error("no tokenization pass ran");
  }
  console.log(
    `[node-check] tokenize timings (ms) over 5 passes: ${timings.map((value) => value.toFixed(2)).join(", ")}`,
  );
  const packedBytes = lastPacked.runs.byteLength;
  const perCharBytes = text.length * 4;
  console.log(
    `[node-check] packed run bytes: ${String(packedBytes)} (per-char baseline: ${String(perCharBytes)}, ratio: ${(packedBytes / perCharBytes).toFixed(4)})`,
  );

  // 200-file dataset total packed size + total Node tokenization time (lower bound reference).
  const groupCount = 10;
  const perGroupCount = 20;
  let totalChars = 0;
  let totalLines = 0;
  let totalPackedBytes = 0;
  const datasetStartedAt = performance.now();
  for (let index = 0; index < groupCount * perGroupCount; index += 1) {
    const group = String(index % groupCount).padStart(2, "0");
    const kind = index % 2 === 0 ? "tsx" : "ts";
    const path = join(
      repoRoot,
      "fixtures/reference-dataset",
      `group-${group}`,
      `widget-${String(index).padStart(3, "0")}.${kind}`,
    );
    const fileText = (await readFile(path)).toString("utf8");
    let fileLines = fileText.split("\n");
    if (fileLines[fileLines.length - 1] === "") {
      fileLines = fileLines.slice(0, -1);
    }
    const grammar = kind === "tsx" ? tsx : typescript;
    const packed = packLineRuns(fileLines, grammar);
    totalChars += fileText.length;
    totalLines += fileLines.length;
    totalPackedBytes += packed.runs.byteLength;
  }
  const datasetMs = performance.now() - datasetStartedAt;
  console.log(
    `[node-check] dataset totals: files=${String(groupCount * perGroupCount)} lines=${String(totalLines)} chars=${String(totalChars)} packedBytes=${String(totalPackedBytes)} tokenizeMs=${datasetMs.toFixed(1)}`,
  );

  console.log("[node-check] done");
}

main().catch((error: unknown) => {
  console.error("[node-check] failed", error);
  process.exitCode = 1;
});
