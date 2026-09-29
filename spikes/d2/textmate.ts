import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import {
  INITIAL,
  Registry,
  type IGrammar,
  type IRawGrammar,
  type IRawTheme,
  type StateStack,
} from "vscode-textmate";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import tsGrammar from "tm-grammars/grammars/typescript.json";
import tsxGrammar from "tm-grammars/grammars/tsx.json";
import darkPlus from "tm-themes/themes/dark-plus.json";

export const TYPESCRIPT_SCOPE = "source.ts";
export const TSX_SCOPE = "source.tsx";

interface RawTokenColorSetting {
  readonly name?: string;
  readonly scope?: string | string[];
  readonly settings: {
    readonly fontStyle?: string;
    readonly foreground?: string;
    readonly background?: string;
  };
}

interface VsCodeTheme {
  readonly name?: string;
  readonly colors?: Record<string, string>;
  readonly tokenColors?: RawTokenColorSetting[];
}

const darkPlusTheme = darkPlus as unknown as VsCodeTheme;

export const DARK_PLUS_COLORS = darkPlusTheme.colors ?? {};

// tm-themes ships VS Code theme JSON (`tokenColors`), not vscode-textmate's
// `IRawTheme` shape (`settings`); casting the raw JSON as `IRawTheme` gives
// Registry.setTheme an empty settings list — every scope then falls back to
// the same default color, and the parity guard against Monaco's default
// foreground trivially passes because nothing gets that color either. A
// synthetic global setting carries `colors["editor.foreground"]`/
// `["editor.background"]` (VS Code themes track these outside tokenColors),
// exactly what Monaco's own `vs-dark`-style themes do.
function globalThemeSetting(
  colors: Record<string, string>,
): RawTokenColorSetting {
  return {
    settings: {
      ...(colors["editor.foreground"]
        ? { foreground: colors["editor.foreground"] }
        : {}),
      ...(colors["editor.background"]
        ? { background: colors["editor.background"] }
        : {}),
    },
  };
}

export const DARK_PLUS_THEME: IRawTheme = {
  ...(darkPlusTheme.name ? { name: darkPlusTheme.name } : {}),
  settings: [
    globalThemeSetting(DARK_PLUS_COLORS),
    ...(darkPlusTheme.tokenColors ?? []),
  ],
};

export interface TextMateRuntime {
  registry: Registry;
  typescript: IGrammar;
  tsx: IGrammar;
  colorMap: string[];
}

export interface MonacoTextMateState {
  readonly ruleStack: StateStack;
  clone(): MonacoTextMateState;
  equals(other: MonacoTextMateState): boolean;
}

const rawGrammars = new Map<string, IRawGrammar>([
  [TYPESCRIPT_SCOPE, tsGrammar as unknown as IRawGrammar],
  [TSX_SCOPE, tsxGrammar as unknown as IRawGrammar],
]);

let wasmReady: Promise<unknown> | undefined;

function loadOnigLib(): Promise<{
  createOnigScanner(patterns: string[]): OnigScanner;
  createOnigString(value: string): OnigString;
}> {
  wasmReady ??= fetch(onigWasmUrl).then(async (response) => {
    if (!response.ok) {
      throw new Error(`onig.wasm request failed: ${String(response.status)}`);
    }
    await loadWASM(await response.arrayBuffer());
  });
  return wasmReady.then(() => ({
    createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
    createOnigString: (value: string) => new OnigString(value),
  }));
}

export async function createTextMateRuntime(): Promise<TextMateRuntime> {
  const registry = new Registry({
    onigLib: loadOnigLib(),
    theme: DARK_PLUS_THEME,
    loadGrammar: (scopeName) =>
      Promise.resolve(rawGrammars.get(scopeName) ?? null),
  });
  registry.setTheme(DARK_PLUS_THEME);
  const [typescript, tsx] = await Promise.all([
    registry.loadGrammar(TYPESCRIPT_SCOPE),
    registry.loadGrammar(TSX_SCOPE),
  ]);
  if (!typescript || !tsx) {
    throw new Error("TextMate TypeScript grammars did not load");
  }
  return { registry, typescript, tsx, colorMap: registry.getColorMap() };
}

export function initialState(): StateStack {
  return INITIAL;
}

export function grammarForFile(
  runtime: Pick<TextMateRuntime, "typescript" | "tsx">,
  fileId: string,
): IGrammar {
  return fileId.endsWith(".tsx") ? runtime.tsx : runtime.typescript;
}

export function grammarForScope(
  runtime: Pick<TextMateRuntime, "typescript" | "tsx">,
  languageId: string,
): IGrammar {
  return languageId === "typescriptreact" ? runtime.tsx : runtime.typescript;
}

export function metadataForeground(metadata: number): number {
  return (metadata >>> 15) & 0x1ff;
}

export function createMonacoState(ruleStack: StateStack): MonacoTextMateState {
  return {
    ruleStack,
    clone: () => createMonacoState(ruleStack.clone()),
    equals: (other) => ruleStack.equals(other.ruleStack),
  };
}

export function toHex(color: string | undefined): string {
  return color ? color.toUpperCase() : "#000000";
}

export function toMonacoThemeRules(): {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}[] {
  const tokenColors = (darkPlus as { tokenColors?: unknown }).tokenColors;
  if (!Array.isArray(tokenColors)) {
    return [];
  }
  const rules: {
    token: string;
    foreground?: string;
    background?: string;
    fontStyle?: string;
  }[] = [];
  for (const entry of tokenColors) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const scope = (entry as { scope?: string | string[] }).scope;
    const settings = (entry as { settings?: Record<string, unknown> }).settings;
    if (!settings || !scope) {
      continue;
    }
    const scopes = Array.isArray(scope) ? scope : [scope];
    for (const token of scopes) {
      const rule: {
        token: string;
        foreground?: string;
        background?: string;
        fontStyle?: string;
      } = { token };
      if (typeof settings.foreground === "string") {
        rule.foreground = settings.foreground.replace(/^#/, "");
      }
      if (typeof settings.background === "string") {
        rule.background = settings.background.replace(/^#/, "");
      }
      if (typeof settings.fontStyle === "string") {
        rule.fontStyle = settings.fontStyle;
      }
      rules.push(rule);
    }
  }
  return rules;
}
