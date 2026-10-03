import { describe, expect, it } from "vitest";

import {
  filePath,
  sourceFileIdFor,
  type DiscoveredFile,
  type FileContentChanged,
  type FilesDiscovered,
  type WorkspaceEvent,
} from "../workspace";
import { createEventBus } from "../shared/events";
import { sourceFileId, workspaceFolderId } from "../shared/domain";

describe("filePath", () => {
  it("accepts relative slash-separated source file paths", () => {
    expect(filePath("src/a.ts")).toBe("src/a.ts");
    expect(filePath("a.tsx")).toBe("a.tsx");
  });

  it.each([
    "",
    "/src/a.ts",
    "\\src/a.ts",
    "src//a.ts",
    "src/./a.ts",
    "src/../a.ts",
    "src/a.ts/",
  ])("throws for %j", (value) => {
    expect(() => filePath(value)).toThrow(RangeError);
  });
});

describe("sourceFileIdFor", () => {
  it("derives a Source File id from its File Path", () => {
    expect(sourceFileIdFor(filePath("src/a.ts"))).toBe(
      sourceFileId("src/a.ts"),
    );
  });
});

describe("WorkspaceEvent delivery", () => {
  it("routes each event to its typed subscriber with fields intact", () => {
    const bus = createEventBus<WorkspaceEvent>();
    const folderId = workspaceFolderId("folder-1");
    const fileId = sourceFileId("src/a.ts");
    const file: DiscoveredFile = {
      fileId,
      path: filePath("src/a.ts"),
      lineCount: 2,
    };
    const discovered: FilesDiscovered = {
      type: "FilesDiscovered",
      folderId,
      files: [file],
    };
    const changed: FileContentChanged = {
      type: "FileContentChanged",
      fileId,
      contentVersion: 1,
      text: "const answer = 42;\n",
      lineCount: 2,
    };
    const received: WorkspaceEvent[] = [];

    bus.subscribe("FilesDiscovered", (event) => {
      received.push(event);
    });
    bus.subscribe("FileContentChanged", (event) => {
      received.push(event);
    });

    bus.publish(discovered);
    expect(received).toEqual([discovered]);

    bus.publish(changed);
    expect(received).toEqual([discovered, changed]);
  });
});
