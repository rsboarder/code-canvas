import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const viteConfig = fileURLToPath(
  new URL("../../vite.config.ts", import.meta.url),
);
const outputDirectories: string[] = [];
type BuildOutput = Extract<
  Awaited<ReturnType<typeof build>>,
  { output: unknown[] }
>;

async function buildBundle(
  harnessFlag: string | undefined,
): Promise<{ text: string; moduleIds: string[] }> {
  const outputDirectory = await mkdtemp(join(tmpdir(), "code-canvas-build-"));
  outputDirectories.push(outputDirectory);
  const previousFlag = process.env.VITE_PERF_HARNESS;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  if (harnessFlag === undefined) delete process.env.VITE_PERF_HARNESS;
  else process.env.VITE_PERF_HARNESS = harnessFlag;

  try {
    const result = await build({
      root: repoRoot,
      configFile: viteConfig,
      mode: "production",
      logLevel: "silent",
      build: { outDir: outputDirectory, emptyOutDir: true },
    });
    const outputs = rollupOutputs(result);
    return {
      text: await readBundle(outputDirectory),
      moduleIds: outputs.flatMap((output) =>
        output.output.flatMap((item) =>
          item.type === "chunk" ? item.moduleIds : [],
        ),
      ),
    };
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env.VITE_PERF_HARNESS;
    else process.env.VITE_PERF_HARNESS = previousFlag;
  }
}

function rollupOutputs(
  result: Awaited<ReturnType<typeof build>>,
): BuildOutput[] {
  if (Array.isArray(result)) return result;
  if ("output" in result) return [result];
  throw new Error("Vite returned a watcher instead of a build output");
}

async function readBundle(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? readBundle(path) : readFile(path, "utf8");
    }),
  );
  return contents.join("\n");
}

function includesModule(moduleIds: readonly string[], path: string): boolean {
  return moduleIds.some((moduleId) => moduleId.endsWith(path));
}

describe("performance harness build boundary", () => {
  afterEach(async () => {
    await Promise.all(
      outputDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("strips the bridge and mock from a regular build", async () => {
    const regularBundle = await buildBundle(undefined);

    expect(regularBundle.text).not.toContain("__perf");
    expect(regularBundle.text).not.toContain("__codeCanvasTest");
    expect(regularBundle.text).not.toContain("setSyntheticLoad");
    expect(regularBundle.text).not.toContain("resetCameraRange");
    expect(regularBundle.text).not.toContain("synthetic-load");
    expect(regularBundle.text).not.toContain("syntheticGpuLoadIterations");
    expect(
      includesModule(
        regularBundle.moduleIds,
        "src/performance/install-bridge.ts",
      ),
    ).toBe(false);
    expect(
      includesModule(
        regularBundle.moduleIds,
        "src/performance/file-system-access-mock.ts",
      ),
    ).toBe(false);
  }, 120_000);

  it("includes the bridge and mock in a harness build", async () => {
    const harnessBundle = await buildBundle("1");

    expect(harnessBundle.text).toContain("__perf");
    expect(harnessBundle.text).toContain("setSyntheticLoad");
    expect(harnessBundle.text).toContain("setCamera");
    expect(harnessBundle.text).toContain("resetCameraRange");
    expect(harnessBundle.text).toContain("synthetic-load");
    expect(harnessBundle.text).toContain("syntheticGpuLoadIterations");
    expect(
      includesModule(
        harnessBundle.moduleIds,
        "src/performance/install-bridge.ts",
      ),
    ).toBe(true);
    expect(
      includesModule(
        harnessBundle.moduleIds,
        "src/performance/file-system-access-mock.ts",
      ),
    ).toBe(true);
  }, 120_000);
});
