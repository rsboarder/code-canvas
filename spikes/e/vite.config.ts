import { mergeConfig, defineConfig } from "vite";
import rootConfig from "../../vite.config";
import { monacoWorkerShimPlugin } from "./monaco-worker-shim-plugin";

export default defineConfig(
  mergeConfig(rootConfig, {
    worker: {
      plugins: () => [monacoWorkerShimPlugin()],
    },
  }),
);
