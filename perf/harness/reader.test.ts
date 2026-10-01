import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { readReferenceFiles } from "./runner";

describe("reference dataset reader", () => {
  it("reads TypeScript files recursively with paths relative to the dataset", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-canvas-dataset-"));
    try {
      await mkdir(join(root, "group-00"));
      await mkdir(join(root, "group-01", "nested"), { recursive: true });
      await writeFile(join(root, "group-00", "widget-000.tsx"), "export {};");
      await writeFile(
        join(root, "group-01", "nested", "widget-001.ts"),
        "export {};",
      );
      await writeFile(join(root, "README.md"), "ignored");

      const files = await readReferenceFiles(root);

      expect(files).toEqual([
        { path: "group-00/widget-000.tsx", text: "export {};" },
        { path: "group-01/nested/widget-001.ts", text: "export {};" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
