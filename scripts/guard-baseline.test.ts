import { describe, expect, it } from "vitest";

import { baselineChangeAllowed } from "./guard-baseline";

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
  ])("$name", ({ stagedFiles, confirmation, expected }) => {
    expect(baselineChangeAllowed(stagedFiles, confirmation)).toBe(expected);
  });
});
