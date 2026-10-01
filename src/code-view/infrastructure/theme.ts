import darkPlus from "tm-themes/themes/dark-plus.json";

interface ThemePalette {
  readonly background: string;
  readonly foreground: string;
  readonly colors: readonly string[];
}

interface ThemeJson {
  readonly colors?: Record<string, string>;
  readonly tokenColors?: readonly {
    readonly settings?: { readonly foreground?: string };
  }[];
}

const rawTheme = darkPlus as ThemeJson;
const colors = rawTheme.tokenColors
  ?.map((entry) => entry.settings?.foreground?.toUpperCase())
  .filter((color): color is string => Boolean(color));

export const themePalette: ThemePalette = {
  background: rawTheme.colors?.["editor.background"] ?? "#1E1E1E",
  foreground: rawTheme.colors?.["editor.foreground"] ?? "#D4D4D4",
  colors: [
    ...new Set([
      rawTheme.colors?.["editor.foreground"] ?? "#D4D4D4",
      ...(colors ?? []),
    ]),
  ],
};
