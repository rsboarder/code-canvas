import { describe, expect, it } from "vitest";

import { LineNumberGutter } from "../code-view/index";

describe("LineNumberGutter", () => {
  it("uses Monaco's rounded line-number geometry", () => {
    const gutter = new LineNumberGutter(9.633);

    expect(gutter.numberAreaWidth(999)).toBe(39);
    expect(gutter.numberAreaWidth(2_000)).toBe(39);
    expect(gutter.codeLeft(2_000)).toBe(47);
  });

  it("maps the code origin to zero for a 2000-line body", () => {
    const gutter = new LineNumberGutter(9.633);

    expect(gutter.codeX(2_000, gutter.codeLeft(2_000))).toBe(0);
  });
});
