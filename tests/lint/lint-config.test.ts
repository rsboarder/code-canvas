import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import type { Linter } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

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
  },
  {
    fixture: "allowed/application-context-imports.ts",
    virtualPath: "src/board/application/x.ts",
  },
  {
    fixture: "allowed/infrastructure-context-imports.ts",
    virtualPath: "src/board/infrastructure/x.ts",
  },
  {
    fixture: "allowed/app-composition-imports.ts",
    virtualPath: "src/app/main.ts",
  },
  {
    fixture: "allowed/editing-monaco-import.ts",
    virtualPath: "src/editing/infrastructure/x.ts",
  },
  {
    fixture: "allowed/code-view-monaco-import.ts",
    virtualPath: "src/code-view/infrastructure/x.ts",
  },
  {
    fixture: "allowed/rendering-twgl-import.ts",
    virtualPath: "src/rendering/gl/x.ts",
  },
  {
    fixture: "allowed/rendering-board-import.ts",
    virtualPath: "src/rendering/x.ts",
  },
  {
    fixture: "allowed/interaction-board-import.ts",
    virtualPath: "src/interaction/x.ts",
  },
] as const;

const forbiddenRuleIds = new Set([
  "no-restricted-globals",
  "no-restricted-imports",
]);

let eslint: ESLint;

function isForbiddenRule(ruleId: string | null): boolean {
  return (
    typeof ruleId === "string" &&
    (ruleId.startsWith("boundaries/") || forbiddenRuleIds.has(ruleId))
  );
}

async function createEslint(): Promise<ESLint> {
  return new ESLint({
    cwd: repoRoot,
    errorOnUnmatchedPattern: false,
    overrideConfigFile: true,
    overrideConfig: [
      ...(await loadLintConfig()),
      {
        files: ["src/**/*.ts"],
        settings: {
          "boundaries/include": ["src/**/*", "tests/lint/fixtures/src/**/*"],
        },
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
                "src/editing/infrastructure/x.ts",
                "src/code-view/infrastructure/x.ts",
                "src/rendering/gl/x.ts",
                "src/rendering/x.ts",
                "src/interaction/x.ts",
              ],
            },
          },
        },
      },
    ],
  });
}

async function lintFixture(fixture: string, virtualPath: string) {
  const source = await readFile(
    `${repoRoot}/tests/lint/fixtures/${fixture}`,
    "utf8",
  );

  const [result] = await eslint.lintText(source, {
    filePath: `${repoRoot}/${virtualPath}`,
  });
  return result?.messages.map((message) => message.ruleId);
}

describe("lint architecture rules", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    eslint = await createEslint();
    await lintFixture(
      "allowed/domain-shared-imports.ts",
      "src/board/domain/x.ts",
    );
  }, 60_000);

  it.each(violationCases)("reports $ruleId for $fixture", async (testCase) => {
    const ruleIds = await lintFixture(testCase.fixture, testCase.virtualPath);

    expect(ruleIds).toContain(testCase.ruleId);
  });

  it.each(allowedCases)("allows $fixture", async (testCase) => {
    const ruleIds = await lintFixture(testCase.fixture, testCase.virtualPath);

    expect(ruleIds?.filter(isForbiddenRule)).toEqual([]);
  });
});
