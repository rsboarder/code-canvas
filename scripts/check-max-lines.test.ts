import { describe, expect, it } from "vitest";

import { existingFiles } from "./check-max-lines";

describe("check-max-lines file discovery", () => {
  it("skips files that no longer exist", () => {
    expect(
      existingFiles(
        ["present.css", "deleted.css"],
        (file) => file === "present.css",
      ),
    ).toEqual(["present.css"]);
  });
});
