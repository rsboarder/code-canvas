interface MonacoThemeRule {
  readonly token: string;
  readonly foreground: string;
}

export function monacoTokenName(colorId: number): string {
  return `tm-${String(colorId)}`;
}

export function buildMonacoThemeRules(
  colorMap: readonly unknown[],
): MonacoThemeRule[] {
  const rules: MonacoThemeRule[] = [];
  colorMap.forEach((color, colorId) => {
    if (typeof color !== "string") return;
    const foreground = color.replace(/^#/, "").toUpperCase();
    if (!/^[0-9A-F]{6}$/u.test(foreground)) return;
    rules.push({ token: monacoTokenName(colorId), foreground });
  });
  return rules;
}
