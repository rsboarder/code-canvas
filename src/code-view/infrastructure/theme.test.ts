import { Registry } from "vscode-textmate";
import { describe, expect, it } from "vitest";

import { monacoTheme, textMateTheme, themePalette } from "./theme";
import { monacoTokenName } from "./theme-rules";

function freshColorMap(): readonly string[] {
  const registry = new Registry({
    onigLib: new Promise<never>(() => undefined),
    theme: textMateTheme,
    loadGrammar: () => Promise.resolve(null),
  });
  return registry.getColorMap();
}

describe("theme", () => {
  it("uses the TextMate colour map as its palette", () => {
    const colorMap = freshColorMap();

    expect(themePalette.colors).toHaveLength(colorMap.length);
    expect(themePalette.colors[0]).toBe(themePalette.foreground);
    for (let colorId = 1; colorId < colorMap.length; colorId += 1) {
      expect(themePalette.colors[colorId]).toBe(colorMap[colorId]);
    }
    expect(
      themePalette.colors.every((color) => /^#[0-9A-F]{6}$/u.test(color)),
    ).toBe(true);
  });

  it("has a Monaco rule for every palette colour id", () => {
    const rulesByToken = new Map(
      monacoTheme.rules.map((rule) => [rule.token, rule.foreground]),
    );

    expect(monacoTheme.rules).toHaveLength(themePalette.colors.length);
    monacoTheme.rules.forEach((rule) => {
      const colorId = Number(rule.token.slice("tm-".length));
      expect(rule.foreground).toBe(themePalette.colors[colorId]?.slice(1));
    });
    for (let colorId = 1; colorId < themePalette.colors.length; colorId += 1) {
      const color = themePalette.colors[colorId];
      expect(rulesByToken.get(monacoTokenName(colorId))).toBe(color?.slice(1));
    }
  });

  it("uses the palette background and foreground in Monaco", () => {
    expect(monacoTheme.colors["editor.background"]).toBe(
      themePalette.background,
    );
    expect(monacoTheme.colors["editor.foreground"]).toBe(
      themePalette.foreground,
    );
    expect(monacoTheme.colors["editorLineNumber.foreground"]).toBe(
      themePalette.lineNumber,
    );
  });
});
