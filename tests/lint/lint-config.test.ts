import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import type { Linter } from "eslint";
import boundaries from "eslint-plugin-boundaries";
import {
  boundaryRules,
  boundarySettings,
  moduleMap,
} from "../../scripts/module-map.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /\/$/u,
  "",
);

async function loadLintConfig(): Promise<Linter.Config[]> {
  const configUrl = pathToFileURL(`${repoRoot}/eslint.config.mjs`).href;
  const configModule = (await import(configUrl)) as unknown as {
    default: Linter.Config[];
  };

  return configModule.default.map((entry) => {
    if (!entry.ignores) {
      return entry;
    }

    return {
      ...entry,
      ignores: entry.ignores.filter(
        (pattern) => pattern !== "tests/lint/fixtures/**",
      ),
    };
  });
}

const violationCases = [
  {
    fixture: "domain-to-infrastructure.ts",
    virtualPath: "src/board/domain/fixture.ts",
    ruleId: "boundaries/dependencies",
  },
  {
    fixture: "deep-context-import.ts",
    virtualPath: "src/board/application/fixture.ts",
    ruleId: "boundaries/dependencies",
  },
  {
    fixture: "infrastructure-from-non-app.ts",
    virtualPath: "src/board/application/fixture.ts",
    ruleId: "boundaries/dependencies",
  },
  {
    fixture: "external-module-in-domain.ts",
    virtualPath: "src/board/domain/fixture.ts",
    ruleId: "boundaries/dependencies",
  },
  {
    fixture: "unknown-src-file.ts",
    virtualPath: "src/board/helpers.ts",
    ruleId: "boundaries/no-unknown-files",
  },
  {
    fixture: "dynamic-monaco-import.ts",
    virtualPath: "src/app/fixture.ts",
    ruleId: "no-restricted-syntax",
  },
  {
    fixture: "dynamic-twgl-import.ts",
    virtualPath: "src/app/fixture.ts",
    ruleId: "no-restricted-syntax",
  },
  {
    fixture: "restricted-html-apis.ts",
    virtualPath: "src/app/fixture.ts",
    ruleId: "no-restricted-properties",
  },
  {
    fixture: "cycle-a.ts",
    virtualPath: "src/board/application/cycle-a.ts",
    ruleId: "import-x/no-cycle",
  },
  {
    fixture: "monaco-outside-infrastructure.ts",
    virtualPath: "src/app/fixture.ts",
    ruleId: "no-restricted-imports",
  },
  {
    fixture: "twgl-outside-rendering.ts",
    virtualPath: "src/app/fixture.ts",
    ruleId: "no-restricted-imports",
  },
  {
    fixture: "dom-global-in-domain.ts",
    virtualPath: "src/board/domain/fixture.ts",
    ruleId: "no-restricted-globals",
  },
] as const;

const allowedCases = [
  {
    fixture: "allowed/domain-shared-imports.ts",
    virtualPath: "src/board/domain/x.ts",
    matrix: true,
  },
  {
    fixture: "allowed/application-context-imports.ts",
    virtualPath: "src/board/application/x.ts",
    matrix: true,
  },
  {
    fixture: "allowed/infrastructure-context-imports.ts",
    virtualPath: "src/board/infrastructure/x.ts",
    matrix: true,
  },
  {
    fixture: "allowed/app-composition-imports.ts",
    virtualPath: "src/app/main.ts",
    matrix: true,
  },
  {
    fixture: "allowed/editing-monaco-import.ts",
    virtualPath: "src/editing/infrastructure/x.ts",
    matrix: false,
  },
  {
    fixture: "allowed/code-view-monaco-import.ts",
    virtualPath: "src/code-view/infrastructure/x.ts",
    matrix: false,
  },
  {
    fixture: "allowed/code-view-textmate-import.ts",
    virtualPath: "src/code-view/infrastructure/x.ts",
    matrix: false,
  },
  {
    fixture: "allowed/rendering-twgl-import.ts",
    virtualPath: "src/rendering/gl/x.ts",
    matrix: false,
  },
  {
    fixture: "allowed/rendering-board-import.ts",
    virtualPath: "src/rendering/x.ts",
    matrix: true,
  },
  {
    fixture: "allowed/interaction-board-import.ts",
    virtualPath: "src/interaction/x.ts",
    matrix: true,
  },
] as const;

let eslint: ESLint;
let mirrorEslint: ESLint;
let matrixRoot: string;
let matrixTestRoot: string;

async function createEslint(
  map = moduleMap,
  rootPath = repoRoot,
  cwd = repoRoot,
): Promise<ESLint> {
  return new ESLint({
    cwd,
    errorOnUnmatchedPattern: false,
    overrideConfigFile: true,
    overrideConfig: [
      ...(await loadLintConfig()),
      {
        files: ["**/*.ts"],
        settings: {
          ...boundarySettings(map),
          "boundaries/root-path": rootPath,
          "boundaries/include": [
            "**/src/**/*",
            "**/perf/**/*",
            "**/spikes/**/*",
            "**/fixtures/**/*",
            "**/tests/**/*",
          ],
        },
        rules: boundaryRules(map),
        languageOptions: {
          parserOptions: {
            projectService: {
              allowDefaultProject: [
                "src/*/domain/fixture.ts",
                "src/*/application/fixture.ts",
                "src/*/infrastructure/fixture.ts",
                "src/app/fixture.ts",
                "src/*/domain/x.ts",
                "src/*/application/x.ts",
                "src/*/infrastructure/x.ts",
                "src/app/main.ts",
                "src/board/helpers.ts",
                "src/board/application/cycle-a.ts",
                "tests/lint/fixtures/src/*/*/*.ts",
                "src/editing/infrastructure/x.ts",
                "src/code-view/infrastructure/x.ts",
                "src/rendering/gl/x.ts",
                "src/rendering/x.ts",
                "src/interaction/x.ts",
                "src/*/*/*.ts",
                "src/*/*.ts",
              ],
            },
          },
        },
      },
    ],
  });
}

function createMatrixEslint(
  map = moduleMap,
  cwd = repoRoot,
  rootPath = repoRoot,
): ESLint {
  return new ESLint({
    cwd,
    errorOnUnmatchedPattern: false,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        plugins: { boundaries },
        settings: {
          ...boundarySettings(map),
          "boundaries/root-path": rootPath,
          "boundaries/include": [
            "**/src/**/*",
            "**/perf/**/*",
            "**/spikes/**/*",
            "**/fixtures/**/*",
            "**/tests/**/*",
          ],
          "import/resolver": {
            node: { extensions: [".js", ".ts", ".tsx"] },
          },
        },
        rules: boundaryRules(map),
      },
    ],
  });
}

async function lintFixture(
  fixture: string,
  virtualPath: string,
  linter = eslint,
  rootPath = repoRoot,
) {
  if (fixture === "cycle-a.ts") {
    const [result] = await eslint.lintFiles(
      `${repoRoot}/tests/lint/fixtures/src/board/application/cycle-a.ts`,
    );
    return result?.messages.map((message) => message.ruleId);
  }

  const source = await readFile(
    `${repoRoot}/tests/lint/fixtures/${fixture}`,
    "utf8",
  );

  const [result] = await linter.lintText(source, {
    filePath: `${rootPath}/${virtualPath}`,
  });
  return result?.messages.map((message) => message.ruleId);
}

describe("lint architecture rules", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    eslint = await createEslint();
    matrixRoot = await createTemporaryMatrixRoot();
    mirrorEslint = createMatrixEslint(moduleMap, matrixRoot, matrixRoot);
    await lintFixture(
      "allowed/domain-shared-imports.ts",
      "src/board/domain/x.ts",
      mirrorEslint,
      matrixRoot,
    );
  }, 60_000);

  afterAll(async () => {
    await rm(matrixRoot, { recursive: true, force: true });
  });

  it.each(violationCases)("reports $ruleId for $fixture", async (testCase) => {
    const ruleIds = await lintFixture(testCase.fixture, testCase.virtualPath);

    expect(ruleIds).toContain(testCase.ruleId);
  });

  it.each(allowedCases)("allows $fixture", async (testCase) => {
    const linter = testCase.matrix ? mirrorEslint : eslint;
    const rootPath = linter === mirrorEslint ? matrixRoot : repoRoot;
    const ruleIds = await lintFixture(
      testCase.fixture,
      testCase.virtualPath,
      linter,
      rootPath,
    );

    expect(ruleIds).toEqual([]);
  });
});

type MatrixKind =
  | "domain"
  | "application"
  | "infrastructure"
  | "entry"
  | "rendering"
  | "interaction"
  | "performance"
  | "shared"
  | "app"
  | "perf"
  | "spikes"
  | "fixtures"
  | "tests";

interface MatrixModule {
  name: string;
  kind: MatrixKind;
  path: string;
  context?: string;
}

interface MutableBoundaryPolicy {
  from?: { element?: { type?: string } };
  allow?: {
    to?: { element?: { types?: { anyOf?: string[] } } };
  };
}

const matrixModules: MatrixModule[] = [
  ...moduleMap.coreContexts.flatMap((context) =>
    moduleMap.coreLayers.map((kind) => ({
      name: `${context}/${kind}`,
      kind: kind as MatrixKind,
      context,
      path: `src/${context}/${kind}/target.ts`,
    })),
  ),
  ...moduleMap.coreContexts.map((context) => ({
    name: `${context}/index`,
    kind: "entry" as const,
    context,
    path: `src/${context}/index.ts`,
  })),
  ...moduleMap.technicalModules.map((kind) => ({
    name: kind,
    kind: kind as MatrixKind,
    path: `src/${kind}/target.ts`,
  })),
  ...moduleMap.sharedAreas.map((area) => ({
    name: `shared/${area}`,
    kind: area === "domain" ? ("domain" as const) : ("shared" as const),
    ...(area === "domain" ? { context: "shared" } : {}),
    path: `src/shared/${area}/target.ts`,
  })),
  { name: "app", kind: "app", path: "src/app/target.ts" },
  ...moduleMap.outsideAreas.map((area) => ({
    name: area,
    kind: area as MatrixKind,
    path: `${area}/target.ts`,
  })),
];

function sameKindAllowed(from: MatrixModule, to: MatrixModule): boolean {
  return (
    from.kind === to.kind &&
    from.kind !== "entry" &&
    (from.context === to.context || (!from.context && !to.context))
  );
}

function domainEdgeAllowed(_from: MatrixModule, to: MatrixModule): boolean {
  return (
    (to.kind === "domain" && to.context === "shared") ||
    (to.kind === "shared" && to.name === "shared/geometry")
  );
}

function applicationEdgeAllowed(from: MatrixModule, to: MatrixModule): boolean {
  return (
    (to.kind === "domain" && to.context === from.context) ||
    (to.kind === "domain" && to.context === "shared") ||
    to.kind === "shared" ||
    to.kind === "entry"
  );
}

function infrastructureEdgeAllowed(
  from: MatrixModule,
  to: MatrixModule,
): boolean {
  return (
    (to.kind === "domain" &&
      (to.context === from.context || to.context === "shared")) ||
    (to.kind === "application" && to.context === from.context) ||
    to.kind === "shared"
  );
}

function entryEdgeAllowed(from: MatrixModule, to: MatrixModule): boolean {
  return (
    (to.kind === "domain" && to.context === from.context) ||
    (to.kind === "application" && to.context === from.context) ||
    to.kind === "shared"
  );
}

function technicalEdgeAllowed(from: MatrixModule, to: MatrixModule): boolean {
  return to.kind === from.kind || to.kind === "shared" || to.kind === "entry";
}

function performanceEdgeAllowed(
  _from: MatrixModule,
  to: MatrixModule,
): boolean {
  return to.kind === "performance" || to.kind === "shared";
}

function outsideEdgeAllowed(from: MatrixModule, to: MatrixModule): boolean {
  return from.kind !== "perf" || to.kind === "perf";
}

const edgeRules: Record<
  MatrixKind,
  (from: MatrixModule, to: MatrixModule) => boolean
> = {
  app: (_from, to) => !moduleMap.outsideAreas.includes(to.kind),
  domain: domainEdgeAllowed,
  application: applicationEdgeAllowed,
  infrastructure: infrastructureEdgeAllowed,
  entry: entryEdgeAllowed,
  rendering: technicalEdgeAllowed,
  interaction: technicalEdgeAllowed,
  performance: performanceEdgeAllowed,
  shared: (_from, to) => to.kind === "shared",
  perf: outsideEdgeAllowed,
  spikes: () => true,
  fixtures: () => true,
  tests: () => true,
};

function isAllowedEdge(from: MatrixModule, to: MatrixModule): boolean {
  return sameKindAllowed(from, to) || edgeRules[from.kind](from, to);
}

function matrixModule(name: string): MatrixModule {
  const module = matrixModules.find((candidate) => candidate.name === name);
  if (!module) {
    throw new Error(`Missing matrix module: ${name}`);
  }

  return module;
}

function matrixSourcePath(
  from: MatrixModule,
  rootPath = matrixTestRoot,
): string {
  if (from.kind === "entry") {
    return `${rootPath}/${from.path}`;
  }

  return `${rootPath}/${from.path.replace(/target\.ts$/u, "source.ts")}`;
}

function matrixImport(
  from: MatrixModule,
  to: MatrixModule,
  rootPath = matrixTestRoot,
): string {
  const targetPath = `${rootPath}/${to.path}`;
  const importPath = relative(
    dirname(matrixSourcePath(from, rootPath)),
    targetPath,
  )
    .replace(/\.ts$/u, "")
    .replace(/\\/gu, "/");

  return importPath.startsWith(".") ? importPath : `./${importPath}`;
}

async function lintMatrixEdge(
  linter: ESLint,
  from: MatrixModule,
  to: MatrixModule,
  rootPath = matrixTestRoot,
) {
  const source = `import * as target from "${matrixImport(from, to, rootPath)}";\nvoid target;`;
  const [result] = await linter.lintText(source, {
    filePath: matrixSourcePath(from, rootPath),
  });
  return result?.messages.map((message) => message.ruleId);
}

async function createTemporaryMatrixRoot(): Promise<string> {
  const rootPath = await mkdtemp("/tmp/module-map-matrix-");

  await Promise.all(
    matrixModules.map(async (module) => {
      const targetPath = `${rootPath}/${module.path}`;
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(
        targetPath,
        `export const target = ${JSON.stringify(module.name)};\n`,
      );
    }),
  );

  return rootPath;
}

async function lintFromTemporaryCwd(
  from: MatrixModule,
  to: MatrixModule,
): Promise<(string | null)[] | undefined> {
  const temporaryRoot = await createTemporaryMatrixRoot();

  try {
    const linter = createMatrixEslint(moduleMap, temporaryRoot, temporaryRoot);
    return await lintMatrixEdge(linter, from, to, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

describe("Module Map boundary matrix", { timeout: 120_000 }, () => {
  let matrixEslint: ESLint;

  beforeAll(async () => {
    matrixTestRoot = await createTemporaryMatrixRoot();
    matrixEslint = createMatrixEslint(
      moduleMap,
      matrixTestRoot,
      matrixTestRoot,
    );
  }, 60_000);

  afterAll(async () => {
    await rm(matrixTestRoot, { recursive: true, force: true });
  });

  it.each(
    matrixModules.flatMap((from) => matrixModules.map((to) => ({ from, to }))),
  )(
    "$from.name -> $to.name is classified according to D3",
    async ({ from, to }) => {
      const ruleIds = await lintMatrixEdge(matrixEslint, from, to);

      expect(ruleIds).not.toContain("boundaries/no-unknown-files");
      if (isAllowedEdge(from, to)) {
        expect(ruleIds).not.toContain("boundaries/dependencies");
        return;
      }

      expect(ruleIds).toContain("boundaries/dependencies");
    },
  );

  it("has no technical public-entry classification", async () => {
    const technicalEntry = `${matrixTestRoot}/src/interaction/source.ts`;
    const [result] = await matrixEslint.lintText(
      `import * as target from "../rendering/index";`,
      { filePath: technicalEntry },
    );

    expect(result?.messages.map((message) => message.ruleId)).toContain(
      "boundaries/dependencies",
    );
  });

  it("gives the same result when linting from another cwd", async () => {
    const from = matrixModule("interaction");
    const to = matrixModule("board/index");
    const inRepo = await lintMatrixEdge(matrixEslint, from, to);
    const outsideRepo = await lintFromTemporaryCwd(from, to);

    expect(outsideRepo).toEqual(inRepo);
  });

  it("detects a mutated generated edge", async () => {
    const mutatedMap = structuredClone(moduleMap);
    const policies =
      mutatedMap.boundaryPolicies as unknown as MutableBoundaryPolicy[];
    const interactionPolicy = policies.find(
      (policy) =>
        policy.from?.element?.type === "interaction" &&
        policy.allow?.to?.element?.types?.anyOf,
    );
    const allowedTypes = interactionPolicy?.allow?.to?.element?.types?.anyOf;

    if (!allowedTypes) {
      throw new Error("Interaction policy is missing from the Module Map");
    }

    allowedTypes.push("rendering");
    const mutatedEslint = createMatrixEslint(mutatedMap);
    const from = matrixModule("interaction");
    const to = matrixModule("rendering");
    const ruleIds = await lintMatrixEdge(mutatedEslint, from, to);

    expect(isAllowedEdge(from, to)).toBe(false);
    expect(ruleIds).not.toContain("boundaries/dependencies");
  });
});
