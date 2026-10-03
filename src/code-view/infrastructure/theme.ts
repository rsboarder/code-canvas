import darkPlus from "tm-themes/themes/dark-plus.json";
import { Registry, type IRawTheme } from "vscode-textmate";
import type { editor } from "monaco-editor/editor/editor.api.js";

import type { ThemePalette } from "../domain/theme-palette";
import { buildMonacoThemeRules } from "./theme-rules";

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

interface RawThemeSetting {
  readonly scope?: string | string[];
  readonly settings: {
    readonly foreground?: string;
    readonly background?: string;
    readonly fontStyle?: string;
  };
}

const sourceTheme = darkPlus as ThemeJson;
const background = sourceTheme.colors?.["editor.background"] ?? "#1E1E1E";
const foreground = sourceTheme.colors?.["editor.foreground"] ?? "#D4D4D4";

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

export const textMateTheme: IRawTheme = {
  ...(sourceTheme.name ? { name: sourceTheme.name } : {}),
  settings: [
    {
      settings: { foreground, background },
    },
    ...(sourceTheme.tokenColors ?? []).map(themeSetting),
  ],
};

const colorMapRegistry = new Registry({
  onigLib: new Promise<never>(() => undefined),
  theme: textMateTheme,
  loadGrammar: () => Promise.resolve(null),
});
const colors = colorMapRegistry.getColorMap();
colors[0] = foreground;

export const themePalette: ThemePalette = {
  background,
  foreground,
  colors,
};

export const monacoTheme: editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: false,
  rules: buildMonacoThemeRules(themePalette.colors),
  colors: {
    "editor.background": themePalette.background,
    "editor.foreground": themePalette.foreground,
  },
};
