import {
  Registry,
  type IGrammar,
  type IRawGrammar,
  type IRawTheme,
} from "vscode-textmate";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import tsGrammar from "tm-grammars/grammars/typescript.json";
import tsxGrammar from "tm-grammars/grammars/tsx.json";
import darkPlus from "tm-themes/themes/dark-plus.json";
import { themePalette } from "./theme";

interface ThemeEntry {
  readonly scope?: string | string[];
  readonly settings?: {
    readonly foreground?: string;
    readonly background?: string;
    readonly fontStyle?: string;
  };
}

interface ThemeJson {
  readonly name?: string;
  readonly colors?: Record<string, string>;
  readonly tokenColors?: readonly ThemeEntry[];
}

const sourceTheme = darkPlus as ThemeJson;
interface RawThemeSetting {
  readonly scope?: string | string[];
  readonly settings: {
    readonly foreground?: string;
    readonly background?: string;
    readonly fontStyle?: string;
  };
}

function themeSetting(entry: ThemeEntry): RawThemeSetting {
  const settings = entry.settings ?? {};
  return {
    ...(entry.scope ? { scope: entry.scope } : {}),
    settings: {
      ...(settings.foreground ? { foreground: settings.foreground } : {}),
      ...(settings.background ? { background: settings.background } : {}),
      ...(settings.fontStyle ? { fontStyle: settings.fontStyle } : {}),
    },
  };
}

const rawTheme: IRawTheme = {
  ...(sourceTheme.name ? { name: sourceTheme.name } : {}),
  settings: [
    {
      settings: {
        foreground: themePalette.foreground,
        background: themePalette.background,
      },
    },
    ...(sourceTheme.tokenColors ?? []).map(themeSetting),
  ],
};

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
    theme: rawTheme,
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
