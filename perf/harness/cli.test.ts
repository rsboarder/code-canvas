import { describe, expect, it } from "vitest";

import { exitCodeFor, parseArguments } from "./cli";

describe("harness CLI", () => {
  it("parses quick scenario runs and stage timing", () => {
    expect(parseArguments(["run", "--quick", "--scenario", "Typing"])).toEqual({
      command: "run",
      quick: true,
      scenario: "Typing",
      stageTiming: false,
    });
    expect(parseArguments(["stages"])).toEqual({
      command: "stages",
      quick: false,
      scenario: undefined,
      stageTiming: true,
    });
  });

  it.each([
    ["passed", 0],
    ["failed", 1],
    ["invalid", 2],
    ["stage-passed", 3],
  ] as const)("maps %s to exit code %s", (verdict, code) => {
    expect(exitCodeFor(verdict)).toBe(code);
  });
});
