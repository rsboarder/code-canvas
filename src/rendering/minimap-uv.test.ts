import { describe, expect, it } from "vitest";

import { minimapUvY } from "./minimap-uv";

describe("minimapUvY", () => {
  it("maps the quad's bottom to the uploaded rows", () => {
    expect(minimapUvY(0, 3, 512)).toBe(0);
    expect(minimapUvY(1, 3, 512)).toBe(3 / 512);
  });
});
