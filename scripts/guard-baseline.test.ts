import { describe, expect, it } from "vitest";

import {
  baselineChangeAllowed,
  parseChangedFiles,
  protectedChanges,
} from "./guard-baseline";

describe("baseline guard", () => {
  it.each([
    {
      name: "allows unrelated staged files without confirmation",
      stagedFiles: ["src/app/main.ts"],
      confirmation: undefined,
      expected: true,
    },
    {
      name: "denies a staged baseline without confirmation",
      stagedFiles: ["perf/baseline.json"],
      confirmation: undefined,
      expected: false,
    },
    {
      name: "allows a staged baseline with the confirmation marker",
      stagedFiles: ["perf/baseline.json"],
      confirmation: "1",
      expected: true,
    },
    {
      name: "denies a staged baseline for any other marker value",
      stagedFiles: ["perf/baseline.json"],
      confirmation: "true",
      expected: false,
    },
    {
      name: "denies a staged budgets file without confirmation",
      stagedFiles: ["perf/budgets.json"],
      confirmation: undefined,
      expected: false,
    },
    {
      name: "allows protected files with the confirmation marker",
      stagedFiles: ["perf/budgets.json"],
      confirmation: "1",
      expected: true,
    },
  ])("$name", ({ stagedFiles, confirmation, expected }) => {
    expect(baselineChangeAllowed(stagedFiles, confirmation)).toBe(expected);
  });

  it("parses deleted and renamed paths from git name-status output", () => {
    const output = [
      "D\tperf/baseline.json",
      "R100\tperf/budgets.json\tperf/budgets-renamed.json",
      "M\tsrc/app/main.ts",
    ].join("\n");

    expect(parseChangedFiles(output)).toEqual([
      "perf/baseline.json",
      "perf/budgets.json",
      "perf/budgets-renamed.json",
      "src/app/main.ts",
    ]);
    expect(protectedChanges(parseChangedFiles(output))).toEqual([
      "perf/baseline.json",
      "perf/budgets.json",
    ]);
  });
});
