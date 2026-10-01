import { describe, expect, it } from "vitest";

import {
  updateBaseline,
  type BaselineFileSystem,
  type BaselineUpdateOptions,
  type BaselineUpdateResult,
} from "./baseline";

describe("baseline update", () => {
  it("replaces the baseline only after interactive confirmation", async () => {
    const files = new Map([["perf/baseline.json", '{"old":true}']]);
    const fileSystem: BaselineFileSystem = {
      readFile: (path) => Promise.resolve(files.get(path) ?? ""),
      writeFile: (path, text) => {
        files.set(path, text);
        return Promise.resolve();
      },
    };
    const options: BaselineUpdateOptions = {
      baselinePath: "perf/baseline.json",
      report: '{"new":true}',
      isTTY: true,
      confirmation: "y",
      fileSystem,
    };
    const result: BaselineUpdateResult = await updateBaseline(options);

    expect(result.exitCode).toBe(0);
    expect(files.get("perf/baseline.json")).toBe('{"new":true}');
  });

  it("does not change the baseline without a TTY", async () => {
    const files = new Map([["perf/baseline.json", '{"old":true}']]);
    const fileSystem: BaselineFileSystem = {
      readFile: (path) => Promise.resolve(files.get(path) ?? ""),
      writeFile: (path, text) => {
        files.set(path, text);
        return Promise.resolve();
      },
    };
    const options: BaselineUpdateOptions = {
      baselinePath: "perf/baseline.json",
      report: '{"new":true}',
      isTTY: false,
      fileSystem,
    };
    const result: BaselineUpdateResult = await updateBaseline(options);

    expect(result.exitCode).not.toBe(0);
    expect(files.get("perf/baseline.json")).toBe('{"old":true}');
  });
});
