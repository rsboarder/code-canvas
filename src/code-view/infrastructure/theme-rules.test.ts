import { describe, expect, it } from "vitest";

import { buildMonacoThemeRules, monacoTokenName } from "./theme-rules";

describe("buildMonacoThemeRules", () => {
  it("skips sparse and invalid colour-map entries while preserving ids", () => {
    const colorMap: unknown[] = [];
    colorMap[1] = "#569CD6";
    colorMap[3] = "#CE9178";
    colorMap[4] = "not-a-colour";
    colorMap[5] = { toString: () => "#FFFFFF" };

    const rules = buildMonacoThemeRules(colorMap);

    expect(rules).toEqual([
      { token: monacoTokenName(1), foreground: "569CD6" },
      { token: monacoTokenName(3), foreground: "CE9178" },
    ]);
    expect(rules.every((rule) => /^[0-9A-F]{6}$/u.test(rule.foreground))).toBe(
      true,
    );
    expect(rules.every((rule) => rule.token.startsWith("tm-"))).toBe(true);
  });
});
