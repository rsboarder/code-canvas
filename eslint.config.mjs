import eslint from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

const boundaryElements = [
  { type: "domain", pattern: "src/*/domain", capture: ["context"] },
  {
    type: "application",
    pattern: "src/*/application",
    capture: ["context"],
  },
  {
    type: "infrastructure",
    pattern: "src/*/infrastructure",
    capture: ["context"],
  },
  {
    type: "index",
    pattern: "src/*/index",
    capture: ["context"],
  },
  { type: "shared", pattern: "src/shared" },
  { type: "app", pattern: "src/app" },
  { type: "rendering", pattern: "src/rendering" },
  { type: "interaction", pattern: "src/interaction" },
  { type: "performance", pattern: "src/performance" },
];

const sameContext = { context: "{{ from.element.captured.context }}" };
const sameFileContext = { context: "{{ from.file.captured.context }}" };

const boundaryRules = {
  "boundaries/dependencies": [
    "error",
    {
      default: "disallow",
      policies: [
        {
          from: { element: { type: "domain" } },
          allow: {
            to: {
              element: [
                { type: "domain", captured: { context: "shared" } },
                { type: "shared", fileInternalPath: "geometry/**" },
              ],
            },
          },
        },
        {
          from: { element: { type: "application" } },
          allow: {
            to: {
              element: [
                { type: "domain", captured: sameContext },
                { type: "shared" },
                { type: "index" },
              ],
            },
          },
        },
        {
          from: { element: { type: "application" } },
          allow: { to: { file: { categories: "index" } } },
        },
        {
          from: { element: { type: "infrastructure" } },
          allow: {
            to: {
              element: [
                { type: "domain", captured: sameContext },
                { type: "application", captured: sameContext },
                { type: "shared" },
              ],
            },
          },
        },
        {
          from: { element: { type: "index" } },
          allow: {
            to: {
              element: [
                { type: "domain", captured: sameContext },
                { type: "application", captured: sameContext },
                { type: "shared" },
              ],
            },
          },
        },
        {
          from: { file: { categories: "index" } },
          allow: {
            to: {
              element: [
                { type: "domain", captured: sameFileContext },
                { type: "application", captured: sameFileContext },
                { type: "shared" },
              ],
            },
          },
        },
        {
          from: { element: { type: "shared" } },
          allow: { to: { element: { type: "shared" } } },
        },
        {
          from: { element: { type: "app" } },
          allow: {
            to: {
              element: {
                types: {
                  anyOf: [
                    "domain",
                    "application",
                    "infrastructure",
                    "index",
                    "shared",
                    "rendering",
                    "interaction",
                    "performance",
                  ],
                },
              },
            },
          },
        },
        {
          from: { element: { type: "app" } },
          allow: { to: { file: { categories: "index" } } },
        },
        {
          from: { element: { type: "rendering" } },
          allow: {
            to: {
              element: { types: { anyOf: ["rendering", "shared"] } },
            },
          },
        },
        {
          from: { element: { type: "rendering" } },
          allow: { to: { file: { categories: "index" } } },
        },
        {
          from: { element: { type: "interaction" } },
          allow: {
            to: {
              element: { types: { anyOf: ["interaction", "shared", "index"] } },
            },
          },
        },
        {
          from: { element: { type: "interaction" } },
          allow: { to: { file: { categories: "index" } } },
        },
        {
          from: { element: { type: "performance" } },
          allow: {
            to: {
              element: { types: { anyOf: ["performance", "shared"] } },
            },
          },
        },
        {
          from: {
            element: {
              types: {
                noneOf: ["app"],
              },
            },
          },
          disallow: { to: { element: { type: "infrastructure" } } },
        },
        {
          from: {
            element: {
              types: {
                anyOf: ["infrastructure", "app"],
              },
            },
          },
          allow: { to: { module: { origin: "external" } } },
        },
      ],
    },
  ],
};

const restrictedLibraryImports = [
  {
    group: ["monaco-editor", "monaco-editor/**"],
    message:
      "monaco-editor is allowed only in editing/code-view infrastructure.",
  },
  {
    group: ["twgl.js", "twgl.js/**"],
    message: "twgl.js is allowed only in rendering.",
  },
];

const domGlobals = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "fetch",
  "WebGL2RenderingContext",
  "WebGLRenderingContext",
  "OffscreenCanvas",
  "CanvasRenderingContext2D",
  "Event",
  "CustomEvent",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "localStorage",
  "sessionStorage",
];

const sizeRules = {
  complexity: ["error", 15],
  "max-depth": ["error", 4],
  "max-lines": [
    "error",
    { max: 800, skipBlankLines: false, skipComments: false },
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
      "boundaries/elements": boundaryElements,
      "boundaries/files": [
        {
          category: "index",
          pattern: "src/*/index.ts",
          capture: ["context"],
        },
      ],
      "boundaries/include": ["src/**/*"],
      "import/resolver": {
        node: { extensions: [".js", ".mjs", ".ts", ".tsx"] },
      },
    },
    rules: {
      ...sizeRules,
      ...boundaryRules,
      "import-x/no-cycle": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
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
        { patterns: restrictedLibraryImports },
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
      ],
    },
  },
  {
    files: [
      "src/editing/infrastructure/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "src/code-view/infrastructure/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [restrictedLibraryImports[1]] },
      ],
    },
  },
  {
    files: ["src/rendering/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [restrictedLibraryImports[0]] },
      ],
    },
  },
  {
    files: [
      "src/*/domain/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "src/shared/domain/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "src/shared/geometry/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
    ],
    rules: {
      "no-restricted-globals": ["error", ...domGlobals],
    },
  },
);
