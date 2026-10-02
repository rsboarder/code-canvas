import { describe, expect, it } from "vitest";

import {
  err,
  ok,
  sourceFileId,
  workspaceFolderId,
  type Result,
} from "../shared/domain";

describe("sourceFileId", () => {
  it("brands a non-empty string", () => {
    expect(sourceFileId("src/app/main.ts")).toBe("src/app/main.ts");
  });

  it("throws a RangeError for an empty string", () => {
    expect(() => sourceFileId("")).toThrow(RangeError);
  });
});

describe("workspaceFolderId", () => {
  it("brands a non-empty string", () => {
    expect(workspaceFolderId("folder-1")).toBe("folder-1");
  });

  it("throws a RangeError for an empty string", () => {
    expect(() => workspaceFolderId("")).toThrow(RangeError);
  });
});

describe("Result", () => {
  it("ok() builds a successful result", () => {
    const result: Result<number, string> = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("err() builds a failed result", () => {
    const result: Result<number, string> = err("failed");
    expect(result).toEqual({ ok: false, error: "failed" });
  });
});
