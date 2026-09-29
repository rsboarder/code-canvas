import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const spikeImport = /\b(?:from\s+|import\s*(?:\(\s*)?)["'][^"']*spikes\//u;

describe("root Vite config boundary", () => {
  it("recognizes imports from spikes", () => {
    expect(spikeImport.test('import plugin from "./spikes/plugin";')).toBe(
      true,
    );
  });

  it("does not import a spike", async () => {
    const source = await readFile(
      new URL("../../vite.config.ts", import.meta.url),
      "utf8",
    );

    expect(spikeImport.test(source)).toBe(false);
  });
});
