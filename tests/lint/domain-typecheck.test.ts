import ts from "typescript";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("domain compiler options", () => {
  it("rejects a DOM global without the DOM library", () => {
    const configPath = fileURLToPath(
      new URL("../../tsconfig.domain.json", import.meta.url),
    );
    const config = ts.readConfigFile(configPath, (fileName) =>
      ts.sys.readFile(fileName),
    );
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(configPath),
    );
    const fileName = resolve(
      dirname(configPath),
      "tests/lint/domain-fixture.ts",
    );
    const options: ts.CompilerOptions = parsed.options;
    const host = ts.createCompilerHost(options);
    const source = "export const title = document.title;";
    const defaultGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNew) => {
      if (name === fileName) {
        return ts.createSourceFile(
          name,
          source,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        );
      }
      return defaultGetSourceFile(
        name,
        languageVersion,
        onError,
        shouldCreateNew,
      );
    };

    const program = ts.createProgram(
      [...parsed.fileNames, fileName],
      options,
      host,
    );
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(
      diagnostics.filter((diagnostic) => diagnostic.code === 2584),
    ).toHaveLength(1);
  });
});
