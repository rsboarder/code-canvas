import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const viteConfig = fileURLToPath(
  new URL("../../vite.config.ts", import.meta.url),
);
const outputDirectories: string[] = [];
const workerEntry = "src/code-view/infrastructure/tokenizer.worker.ts";

async function buildTokenizerWorker(): Promise<{
  moduleIds: string[];
  sourceMapSources: string[];
}> {
  const outputDirectory = await mkdtemp(join(tmpdir(), "code-canvas-worker-"));
  outputDirectories.push(outputDirectory);
  const capturedChunks: string[][] = [];
  const capture: Plugin = {
    name: "capture-tokenizer-worker-build",
    generateBundle(_options, bundle) {
      Object.values(bundle).forEach((output) => {
        if (output.type === "chunk") capturedChunks.push([...output.moduleIds]);
      });
    },
  };

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({
      root: repoRoot,
      configFile: viteConfig,
      mode: "production",
      logLevel: "silent",
      worker: { plugins: () => [capture] },
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        sourcemap: true,
      },
    });
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }

  const workerModuleIds = capturedChunks.find((moduleIds) =>
    moduleIds.some((moduleId) => moduleId.endsWith(workerEntry)),
  );
  return {
    moduleIds: workerModuleIds ?? [],
    sourceMapSources:
      workerModuleIds === undefined
        ? await readWorkerSourceMapSources(outputDirectory)
        : [],
  };
}

async function readWorkerSourceMapSources(
  directory: string,
): Promise<string[]> {
  const files = await filesIn(directory);
  const mapFiles = files.filter(
    (file) =>
      basename(file).startsWith("tokenizer.worker-") &&
      file.endsWith(".js.map"),
  );
  const maps = await Promise.all(
    mapFiles.map(async (file) => {
      const map = JSON.parse(await readFile(file, "utf8")) as {
        sources?: string[];
      };
      return map.sources ?? [];
    }),
  );
  return maps.flat();
}

async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesIn(path) : Promise.resolve([path]);
    }),
  );
  return paths.flat();
}

function hasWorkerEntry(moduleIds: readonly string[]): boolean {
  return moduleIds.some((moduleId) => moduleId.endsWith(workerEntry));
}

function hasTextMateModule(moduleIds: readonly string[]): boolean {
  return moduleIds.some((moduleId) => moduleId.includes("vscode-textmate"));
}

function hasMonacoModule(moduleIds: readonly string[]): boolean {
  return moduleIds.some((moduleId) =>
    moduleId.includes("/node_modules/monaco-editor/"),
  );
}

function hasCssModule(moduleIds: readonly string[]): boolean {
  return moduleIds.some(
    (moduleId) => moduleId.split("?", 1)[0]?.endsWith(".css") ?? false,
  );
}

describe("tokenizer worker build boundary", () => {
  afterEach(async () => {
    await Promise.all(
      outputDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("keeps the worker on the TextMate-only build boundary", async () => {
    const workerBuild = await buildTokenizerWorker();
    const observedModules =
      workerBuild.moduleIds.length > 0
        ? workerBuild.moduleIds
        : workerBuild.sourceMapSources;

    expect(
      hasWorkerEntry(workerBuild.moduleIds) ||
        workerBuild.sourceMapSources.some((source) =>
          source.includes(workerEntry),
        ),
    ).toBe(true);
    expect(hasTextMateModule(observedModules)).toBe(true);
    expect(hasMonacoModule(observedModules)).toBe(false);
    expect(hasCssModule(observedModules)).toBe(false);
  }, 120_000);
});
