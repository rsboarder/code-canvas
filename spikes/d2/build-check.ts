import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { build } from "vite";

const spikeRoot = fileURLToPath(new URL("./", import.meta.url));
const configFile = fileURLToPath(
  new URL("../../vite.config.ts", import.meta.url),
);

async function main(): Promise<void> {
  const outputDirectory = await mkdtemp(
    join("/private/tmp", "spike-d2-build-check-"),
  );
  try {
    await build({
      root: spikeRoot,
      configFile,
      build: { outDir: outputDirectory, emptyOutDir: true, sourcemap: true },
    });
    console.log("[build-check] production build done");

    const assetsDir = join(outputDirectory, "assets");
    const files = await readdir(assetsDir);
    console.log(`[build-check] assets: ${files.join(", ")}`);

    const workerAsset = files.find(
      (name) => name.startsWith("tokenizer.worker") && name.endsWith(".js"),
    );
    const onigAsset = files.find(
      (name) => name.startsWith("onig") && name.endsWith(".wasm"),
    );
    if (!workerAsset) {
      throw new Error("no tokenizer.worker-*.js asset found");
    }
    if (!onigAsset) {
      throw new Error("no onig-*.wasm asset found");
    }
    const workerStat = await stat(join(assetsDir, workerAsset));
    const onigStat = await stat(join(assetsDir, onigAsset));
    console.log(
      `[build-check] worker asset: ${workerAsset} (${String(workerStat.size)} bytes)`,
    );
    console.log(
      `[build-check] onig.wasm asset: ${onigAsset} (${String(onigStat.size)} bytes)`,
    );

    const mapName = `${workerAsset}.map`;
    if (files.includes(mapName)) {
      const mapText = await readFile(join(assetsDir, mapName), "utf8");
      const map = JSON.parse(mapText) as { sources?: string[] };
      const monacoSources = (map.sources ?? []).filter((source) =>
        source.includes("monaco-editor"),
      );
      console.log(
        `[build-check] worker source map sources: ${String((map.sources ?? []).length)} total, ${String(monacoSources.length)} from monaco-editor`,
      );
      if (monacoSources.length > 0) {
        console.log(
          `[build-check] monaco-editor sources found: ${monacoSources.join(", ")}`,
        );
      }
      const editorApi = (map.sources ?? []).filter(
        (source) =>
          source.includes("editor.api") ||
          source.includes("standaloneEditor") ||
          source.includes("standalone-tokens.css"),
      );
      console.log(
        `[build-check] editor.api/standaloneEditor/css sources in worker: ${String(editorApi.length)}`,
      );
    } else {
      console.log(`[build-check] no source map found for ${workerAsset}`);
    }

    const mainAsset = files.find(
      (name) => name.startsWith("index") && name.endsWith(".js"),
    );
    console.log(`[build-check] main asset: ${mainAsset ?? "not found"}`);

    console.log("[build-check] done");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("[build-check] failed", error);
  process.exitCode = 1;
});
