const coreContexts = ["workspace", "board", "code-view", "editing"];
const coreLayers = ["domain", "application", "infrastructure"];
const technicalModules = ["rendering", "interaction", "performance"];
const sharedAreas = ["domain", "geometry", "events", "frame"];
const outsideAreas = ["perf", "spikes", "fixtures", "tests"];

const publicEntries = coreContexts.map((context) => ({
  category: `public-entry-${context}`,
  pattern: `src/${context}/index.ts`,
}));

const sameContext = { context: "{{ from.element.captured.context }}" };

const boundaryPolicies = [
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
          { type: "domain", captured: { context: "shared" } },
          { type: "shared" },
        ],
      },
    },
  },
  {
    from: { element: { type: "infrastructure" } },
    allow: {
      to: {
        element: [
          { type: "domain", captured: sameContext },
          { type: "domain", captured: { context: "shared" } },
          { type: "application", captured: sameContext },
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
              "shared",
              ...technicalModules,
            ],
          },
        },
      },
    },
  },
  {
    from: { element: { type: "rendering" } },
    allow: {
      to: { element: { types: { anyOf: ["rendering", "shared"] } } },
    },
  },
  {
    from: { element: { type: "interaction" } },
    allow: {
      to: { element: { types: { anyOf: ["interaction", "shared"] } } },
    },
  },
  {
    from: { element: { type: "performance" } },
    allow: {
      to: { element: { types: { anyOf: ["performance", "shared"] } } },
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
];

for (const context of coreContexts) {
  boundaryPolicies.push({
    from: { file: { categories: `public-entry-${context}` } },
    allow: {
      to: {
        element: [
          { type: "domain", captured: { context } },
          { type: "application", captured: { context } },
          { type: "shared" },
        ],
      },
    },
  });
}

for (const category of publicEntries.map(
  ({ category: entryCategory }) => entryCategory,
)) {
  boundaryPolicies.push({
    from: { element: { type: "application" } },
    allow: { to: { file: { categories: category } } },
  });
  boundaryPolicies.push({
    from: { element: { type: "rendering" } },
    allow: { to: { file: { categories: category } } },
  });
  boundaryPolicies.push({
    from: { element: { type: "interaction" } },
    allow: { to: { file: { categories: category } } },
  });
  boundaryPolicies.push({
    from: { element: { type: "app" } },
    allow: { to: { file: { categories: category } } },
  });
}

for (const type of technicalModules) {
  boundaryPolicies.push({
    from: { element: { type } },
    allow: { to: { module: { origin: "external" } } },
  });
}

boundaryPolicies.push(
  {
    from: { element: { type: "perf" } },
    allow: { to: { element: { type: "perf" } } },
  },
  {
    from: { element: { type: "perf" } },
    allow: { to: { file: { categories: "performance-bridge" } } },
  },
  {
    from: { element: { type: "perf" } },
    allow: { to: { module: { origin: "external" } } },
  },
  {
    from: { element: { type: "perf" } },
    allow: { to: { module: { origin: "core" } } },
  },
);

for (const type of ["spikes", "fixtures", "tests"]) {
  boundaryPolicies.push({
    from: { element: { type } },
    allow: {
      to: {
        element: {
          types: {
            anyOf: [
              ...coreLayers,
              "shared",
              "app",
              ...technicalModules,
              ...outsideAreas,
            ],
          },
        },
      },
    },
  });
  boundaryPolicies.push({
    from: { element: { type } },
    allow: { to: { module: { origin: "external" } } },
  });
  boundaryPolicies.push({
    from: { element: { type } },
    allow: { to: { module: { origin: "core" } } },
  });
  for (const { category } of publicEntries) {
    boundaryPolicies.push({
      from: { element: { type } },
      allow: { to: { file: { categories: category } } },
    });
  }
}

export const MAX_SOURCE_LINES = 800;

export const moduleMap = {
  coreContexts,
  coreLayers,
  technicalModules,
  sharedAreas,
  outsideAreas,
  elements: [
    ...coreLayers.map((type) => ({
      type,
      pattern: `src/*/${type}`,
      capture: ["context"],
    })),
    { type: "shared", pattern: "src/shared" },
    { type: "app", pattern: "src/app" },
    ...technicalModules.map((type) => ({ type, pattern: `src/${type}` })),
    ...outsideAreas.map((type) => ({ type, pattern: type })),
  ],
  files: [
    ...publicEntries.map((entry) => ({ ...entry, capture: ["context"] })),
    { category: "environment", pattern: "src/vite-env.d.ts" },
    {
      category: "performance-bridge",
      pattern: "src/performance/bridge.ts",
    },
  ],
  boundaryPolicies,
  libraryAreas: [
    {
      files: ["src/editing/infrastructure/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
      allowed: ["monaco-editor"],
    },
    {
      files: ["src/code-view/infrastructure/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
      allowed: [
        "monaco-editor",
        "vscode-textmate",
        "vscode-oniguruma",
        "tm-grammars",
        "tm-themes",
      ],
    },
    {
      files: ["src/rendering/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
      allowed: ["twgl.js"],
    },
  ],
  libraries: [
    {
      name: "monaco-editor",
      message:
        "monaco-editor is allowed only in editing/code-view infrastructure.",
    },
    {
      name: "twgl.js",
      message: "twgl.js is allowed only in rendering.",
    },
    {
      name: "vscode-textmate",
      message: "vscode-textmate is allowed only in code-view infrastructure.",
    },
    {
      name: "vscode-oniguruma",
      message: "vscode-oniguruma is allowed only in code-view infrastructure.",
    },
    {
      name: "tm-grammars",
      message: "tm-grammars is allowed only in code-view infrastructure.",
    },
    {
      name: "tm-themes",
      message: "tm-themes is allowed only in code-view infrastructure.",
    },
  ],
  domGlobals: [
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
    "self",
    "globalThis",
    "indexedDB",
    "Worker",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "performance",
    "createImageBitmap",
  ],
  knip: {
    staticEntries: [
      "index.html",
      "src/rendering/frame-loop.ts",
      "src/rendering/index.ts",
    ],
    projectPatterns: [
      "src/**/*.{ts,tsx}",
      "perf/**/*.{ts,tsx}",
      "fixtures/**/*.{ts,tsx}",
      "scripts/**/*.ts",
      "tests/**/*.ts",
      "*.config.{js,mjs,ts}",
    ],
    ignore: ["tests/lint/fixtures/**"],
    ignoreDependencies: [
      "monaco-editor",
      "twgl.js",
      "@paulirish/trace_engine",
      "vscode-textmate",
      "vscode-oniguruma",
      "tm-grammars",
      "tm-themes",
      "webgl-lint",
    ],
  },
};

export function boundarySettings(map = moduleMap) {
  return {
    "boundaries/elements": map.elements,
    "boundaries/files": map.files,
  };
}

export function boundaryRules(map = moduleMap) {
  return {
    "boundaries/dependencies": [
      "error",
      {
        default: "disallow",
        policies: map.boundaryPolicies,
        checkAllOrigins: true,
        checkUnknownLocals: true,
      },
    ],
    "boundaries/no-unknown-files": "error",
  };
}

function packagePattern(name) {
  return {
    group: [name, `${name}/**`],
    message: "Library is restricted here.",
  };
}

function dynamicImportRule(library) {
  const escapedName = library.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    selector: `ImportExpression[source.value=/^${escapedName}(\\/|$)/]`,
    message: library.message,
  };
}

export function libraryRules(map = moduleMap) {
  const patterns = map.libraries.map(({ name, message }) => ({
    ...packagePattern(name),
    message,
  }));
  const dynamicRules = map.libraries.map(dynamicImportRule);

  return {
    restrictedPatterns: patterns,
    dynamicRules,
    areas: map.libraryAreas.map((area) => ({
      files: area.files,
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: patterns.filter(
              (pattern) => !area.allowed.includes(pattern.group[0]),
            ),
          },
        ],
        "no-restricted-syntax": [
          "error",
          ...dynamicRules.filter((rule) =>
            area.allowed.every(
              (library) =>
                !rule.selector.includes(`^${library.replace(".", "\\.")}`),
            ),
          ),
        ],
      },
    })),
  };
}

export function knipConfig(map = moduleMap) {
  return {
    entry: [
      ...map.knip.staticEntries,
      ...map.coreContexts.map((context) => `src/${context}/index.ts`),
    ],
    project: map.knip.projectPatterns,
    ignore: map.knip.ignore,
    ignoreDependencies: map.knip.ignoreDependencies,
  };
}
