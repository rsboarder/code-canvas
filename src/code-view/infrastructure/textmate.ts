import { Registry, type IGrammar, type IRawGrammar } from "vscode-textmate";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import tsGrammar from "tm-grammars/grammars/typescript.json";
import tsxGrammar from "tm-grammars/grammars/tsx.json";
import { textMateTheme } from "./theme";

let wasmReady: Promise<void> | undefined;

function onigLib(): Promise<{
  createOnigScanner(patterns: string[]): OnigScanner;
  createOnigString(value: string): OnigString;
}> {
  wasmReady ??= fetch(onigWasmUrl).then(async (response) => {
    if (!response.ok) throw new Error("TextMate WASM could not be loaded");
    await loadWASM(await response.arrayBuffer());
  });
  return wasmReady.then(() => ({
    createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
    createOnigString: (value: string) => new OnigString(value),
  }));
}

interface TextMateRuntime {
  readonly typescript: IGrammar;
  readonly tsx: IGrammar;
  readonly colorMap: readonly string[];
}

export async function createTextMateRuntime(): Promise<TextMateRuntime> {
  const grammars = new Map<string, IRawGrammar>([
    ["source.ts", tsGrammar as unknown as IRawGrammar],
    ["source.tsx", tsxGrammar as unknown as IRawGrammar],
  ]);
  const registry = new Registry({
    onigLib: onigLib(),
    theme: textMateTheme,
    loadGrammar: (scopeName) =>
      Promise.resolve(grammars.get(scopeName) ?? null),
  });
  const [typescript, tsx] = await Promise.all([
    registry.loadGrammar("source.ts"),
    registry.loadGrammar("source.tsx"),
  ]);
  if (!typescript || !tsx) throw new Error("TypeScript grammars did not load");
  return { typescript, tsx, colorMap: registry.getColorMap() };
}

export function grammarForFile(
  runtime: TextMateRuntime,
  fileId: string,
): IGrammar {
  return fileId.endsWith(".tsx") ? runtime.tsx : runtime.typescript;
}

export function metadataForeground(metadata: number): number {
  return (metadata >>> 15) & 0x1ff;
}
