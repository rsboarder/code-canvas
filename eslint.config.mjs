import eslint from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importX from "eslint-plugin-import-x";
import { fileURLToPath, URL } from "node:url";
import tseslint from "typescript-eslint";
import {
  MAX_SOURCE_LINES,
  boundaryRules,
  boundarySettings,
  libraryRules,
  moduleMap,
} from "./scripts/module-map.mjs";

const configRoot = import.meta.dirname;
const tsconfigPath = fileURLToPath(new URL("./tsconfig.json", import.meta.url));
const spikesTsconfigPath = fileURLToPath(
  new URL("./spikes/tsconfig.json", import.meta.url),
);
const libraries = libraryRules();

const sizeRules = {
  complexity: ["error", 15],
  "max-depth": ["error", 4],
  "max-lines": [
    "error",
    {
      max: MAX_SOURCE_LINES,
      skipBlankLines: false,
      skipComments: false,
    },
  ],
  "max-lines-per-function": ["error", 80],
  "max-params": ["error", 4],
};

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "fixtures/reference-dataset/**",
      "fixtures/edge-case-corpus/**",
      "perf/results/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      "tests/lint/fixtures/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    plugins: { boundaries, "import-x": importX },
    settings: {
      ...boundarySettings(),
      "boundaries/root-path": configRoot,
      "boundaries/include": [
        "**/src/**/*",
        "**/perf/**/*",
        "**/spikes/**/*",
        "**/fixtures/**/*",
        "**/tests/**/*",
      ],
      "import/resolver": {
        typescript: { project: [tsconfigPath, spikesTsconfigPath] },
        node: { extensions: [".js", ".mjs", ".ts", ".tsx"] },
      },
      "import-x/resolver-next": [
        createTypeScriptImportResolver({ project: tsconfigPath }),
      ],
      "import-x/extensions": [".js", ".mjs", ".cjs", ".ts", ".tsx"],
    },
    rules: {
      ...sizeRules,
      ...boundaryRules(),
      "import-x/no-cycle": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: configRoot,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["spikes/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      complexity: "off",
      "max-depth": "off",
      "max-lines": "off",
      "max-lines-per-function": "off",
      "max-params": "off",
    },
  },
  {
    files: ["src/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: libraries.restrictedPatterns },
      ],
      "no-restricted-properties": [
        "error",
        {
          property: "innerHTML",
          message: "Use textContent instead of innerHTML.",
        },
        {
          property: "outerHTML",
          message: "Use textContent instead of outerHTML.",
        },
        {
          property: "insertAdjacentHTML",
          message: "Use DOM APIs that do not parse HTML strings.",
        },
        {
          object: "document",
          property: "write",
          message: "Use DOM APIs instead of document.write.",
        },
      ],
      "no-restricted-syntax": ["error", ...libraries.dynamicRules],
    },
  },
  ...libraries.areas,
  {
    files: [
      "src/*/domain/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "src/shared/domain/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "src/shared/geometry/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
    ],
    rules: {
      "no-restricted-globals": ["error", ...moduleMap.domGlobals],
    },
  },
);
