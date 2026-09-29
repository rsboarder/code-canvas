import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const EDITOR_API_IMPORT = "../../../editor/editor.api.js";
const TYPESCRIPT_DEFINITIONS_PATH =
  "/monaco-editor/esm/vs/languages/definitions/";

export function monacoWorkerShimPlugin(): Plugin {
  const shimPath = fileURLToPath(
    new URL("./editor-api-shim.ts", import.meta.url),
  );
  return {
    name: "spike-e-monaco-worker-editor-api-shim",
    enforce: "pre",
    resolveId(source, importer) {
      const normalizedImporter = importer?.replace(/\\/g, "/");
      if (
        source === EDITOR_API_IMPORT &&
        normalizedImporter?.includes(TYPESCRIPT_DEFINITIONS_PATH)
      ) {
        return shimPath;
      }
      return null;
    },
  };
}
