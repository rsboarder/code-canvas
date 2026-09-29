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
} from "vscode-textmate";
import tsGrammar from "tm-grammars/grammars/typescript.json" with { type: "json" };
import tsxGrammar from "tm-grammars/grammars/tsx.json" with { type: "json" };
import darkPlus from "tm-themes/themes/dark-plus.json" with { type: "json" };
import {
  measureFileIncremental,
  type FileIncrementalMeasurement,
} from "./incremental";

// Same Node-only import workaround as node-check.ts / minimap-check.ts (see
// those files' comments): vscode-textmate/vscode-oniguruma are UMD bundles
// Node's native ESM loader cannot statically detect named exports from.
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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const FILE_COUNT = 20;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

function summarize(values: number[]): {
  median: number;
  p95: number;
  max: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

async function main(): Promise<void> {
  const wasmBytes = await readFile(
    join(repoRoot, "node_modules/vscode-oniguruma/release/onig.wasm"),
  );
  await loadWASM(wasmBytes.buffer);

  const rawGrammars = new Map<string, IRawGrammar>([
    ["source.ts", tsGrammar as unknown as IRawGrammar],
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
  const typescript = await registry.loadGrammar("source.ts");
  const tsx = await registry.loadGrammar("source.tsx");
  if (!typescript || !tsx) {
    throw new Error("grammar failed to load");
  }
  const grammarFor = (kind: "ts" | "tsx"): IGrammar =>
    kind === "tsx" ? tsx : typescript;

  const measurements: FileIncrementalMeasurement[] = [];
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const group = String(index % 10).padStart(2, "0");
    const kind = index % 2 === 0 ? "tsx" : "ts";
    const fileId = `group-${group}/widget-${String(index).padStart(3, "0")}.${kind}`;
    const path = join(repoRoot, "fixtures/reference-dataset", fileId);
    const text = (await readFile(path)).toString("utf8");
    let lines = text.split("\n");
    if (lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    measurements.push(measureFileIncremental(fileId, lines, grammarFor(kind)));
    console.log(
      `[incremental-check] measured ${fileId} (${String(lines.length)} lines)`,
    );
  }

  const coldWindowMs = summarize(
    measurements.map((measurement) => measurement.coldFirstWindow.ms),
  );
  const editAt10IncrementalMs = summarize(
    measurements.map((measurement) => measurement.editAt10.incrementalMs),
  );
  const editAt10RescanMs = summarize(
    measurements.map((measurement) => measurement.editAt10.fullRescanMs),
  );
  const editAt1000IncrementalMs = summarize(
    measurements.map((measurement) => measurement.editAt1000.incrementalMs),
  );
  const editAt1000RescanMs = summarize(
    measurements.map((measurement) => measurement.editAt1000.fullRescanMs),
  );
  const allChunkMs = measurements.flatMap((measurement) =>
    measurement.chunkTimings.map((chunk) => chunk.ms),
  );
  const chunkMsSummary = summarize(allChunkMs);
  const editAt10Converged = measurements.filter(
    (measurement) => measurement.editAt10.converged,
  ).length;
  const editAt1000Converged = measurements.filter(
    (measurement) => measurement.editAt1000.converged,
  ).length;
  const editAt10LinesRetokenized = summarize(
    measurements.map((measurement) => measurement.editAt10.linesRetokenized),
  );
  const editAt1000LinesRetokenized = summarize(
    measurements.map((measurement) => measurement.editAt1000.linesRetokenized),
  );

  console.log(
    `[incremental-check] cold first window (0-60) ms: median=${coldWindowMs.median.toFixed(2)} p95=${coldWindowMs.p95.toFixed(2)} max=${coldWindowMs.max.toFixed(2)}`,
  );
  console.log(
    `[incremental-check] editAt10 incremental ms: median=${editAt10IncrementalMs.median.toFixed(2)} p95=${editAt10IncrementalMs.p95.toFixed(2)} max=${editAt10IncrementalMs.max.toFixed(2)}; fullRescan ms: median=${editAt10RescanMs.median.toFixed(2)} p95=${editAt10RescanMs.p95.toFixed(2)}; converged=${String(editAt10Converged)}/${String(FILE_COUNT)}; linesRetokenized median=${editAt10LinesRetokenized.median.toFixed(1)} p95=${editAt10LinesRetokenized.p95.toFixed(1)}`,
  );
  console.log(
    `[incremental-check] editAt1000 incremental ms: median=${editAt1000IncrementalMs.median.toFixed(2)} p95=${editAt1000IncrementalMs.p95.toFixed(2)} max=${editAt1000IncrementalMs.max.toFixed(2)}; fullRescan ms: median=${editAt1000RescanMs.median.toFixed(2)} p95=${editAt1000RescanMs.p95.toFixed(2)}; converged=${String(editAt1000Converged)}/${String(FILE_COUNT)}; linesRetokenized median=${editAt1000LinesRetokenized.median.toFixed(1)} p95=${editAt1000LinesRetokenized.p95.toFixed(1)}`,
  );
  console.log(
    `[incremental-check] chunk (100 lines) ms over ${String(allChunkMs.length)} chunks: median=${chunkMsSummary.median.toFixed(2)} p95=${chunkMsSummary.p95.toFixed(2)} max=${chunkMsSummary.max.toFixed(2)}`,
  );
  console.log("[incremental-check] done");
}

main().catch((error: unknown) => {
  console.error("[incremental-check] failed", error);
  process.exitCode = 1;
});
