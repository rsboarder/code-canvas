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
import tsxGrammar from "tm-grammars/grammars/tsx.json" with { type: "json" };
import darkPlus from "tm-themes/themes/dark-plus.json" with { type: "json" };

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

const SAMPLE_FILE =
  "function renderWidget(plainIdentifier: string) { return <Widget value={plainIdentifier} />; }";
const SCREENSHOT_SAMPLE = `function renderWidget(plainIdentifier: string) {
  const helperValue = plainIdentifier.trim();
  return <Widget value={helperValue} label="demo" />;
}
`;

function metadataForeground(metadata: number): number {
  return (metadata >>> 15) & 0x1ff;
}

function toHex(color: string | undefined): string {
  return color ? color.toUpperCase() : "#000000";
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

  function dumpLine(
    label: string,
    grammar: IGrammar,
    line: string,
    ruleStack: ReturnType<IGrammar["tokenizeLine2"]>["ruleStack"] | null,
  ): ReturnType<IGrammar["tokenizeLine2"]>["ruleStack"] {
    const result = grammar.tokenizeLine2(line, ruleStack);
    console.log(`--- ${label}: "${line}"`);
    for (let index = 0; index < result.tokens.length; index += 2) {
      const start = result.tokens[index] ?? 0;
      const end = result.tokens[index + 2] ?? line.length;
      const color = metadataForeground(result.tokens[index + 1] ?? 0);
      const hex = toHex(colorMap[color]);
      const text = line.slice(start, end);
      if (text.trim().length > 0) {
        console.log(`  [${String(start)},${String(end)}) "${text}" -> ${hex}`);
      }
    }
    return result.ruleStack;
  }

  console.log(
    "=== SAMPLE_FILE (single line, as used by main.ts syntaxSamples) ===",
  );
  dumpLine("sample", tsx, SAMPLE_FILE, null);

  console.log("");
  console.log("=== SCREENSHOT_SAMPLE (multi-line, as rendered in Monaco) ===");
  let state = null;
  for (const line of SCREENSHOT_SAMPLE.split("\n").slice(0, -1)) {
    state = dumpLine("screenshot", tsx, line, state);
  }

  console.log("");
  console.log("=== indexOf sanity check ===");
  console.log(
    `SAMPLE_FILE.indexOf("Widget") = ${String(SAMPLE_FILE.indexOf("Widget"))} (should be inside "renderWidget" if buggy)`,
  );
  console.log(
    `SAMPLE_FILE.indexOf("renderWidget") = ${String(SAMPLE_FILE.indexOf("renderWidget"))}`,
  );
  console.log(
    `SAMPLE_FILE.indexOf("<Widget") = ${String(SAMPLE_FILE.indexOf("<Widget"))}`,
  );
}

main().catch((error: unknown) => {
  console.error("[diagnose-jsx] failed", error);
  process.exitCode = 1;
});
