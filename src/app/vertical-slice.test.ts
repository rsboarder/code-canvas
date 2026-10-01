import { describe, expect, it } from "vitest";

import { Camera, DetailLevel } from "../board/index";
import {
  DocumentResidency,
  LineLayout,
  type GpuUploader,
  type TokenizedLines,
  type Tokenizer,
} from "../code-view/index";
import { splitSourceLines } from "../shared/domain/line-splitting";

describe("vertical slice domain policies", () => {
  it("splits source lines using the Monaco-compatible rule", () => {
    expect(splitSourceLines("\uFEFFone\r\ntwo\rthree\nfour\n")).toEqual([
      "one",
      "two",
      "three",
      "four",
      "",
    ]);
    expect(splitSourceLines("")).toEqual([""]);
  });

  it("keeps a zoom target fixed and clamps Camera scale", () => {
    const camera = new Camera({ x: 10, y: 20 }, 1);
    camera.zoomToward({ x: 210, y: 120 }, 2);
    expect(camera.offset).toEqual({ x: -190, y: -80 });
    camera.zoomToward({ x: 0, y: 0 }, 0.001);
    expect(camera.scale).toBe(0.05);
  });

  it("switches Detail Level only outside its hysteresis band", () => {
    const detail = new DetailLevel();
    expect(detail.update(9)).toBe("text");
    expect(detail.update(8.9)).toBe("minimap");
    expect(detail.update(11)).toBe("minimap");
    expect(detail.update(11.1)).toBe("text");
  });

  it("computes fractional x prefix sums with tab stops", () => {
    const advances = new Map([
      ["界", 12.75],
      ["🧭", 18.25],
    ]);
    const layout = new LineLayout("a\t界🧭b", {
      narrowAdvance: 7.5,
      tabSize: 4,
      baseline: 14,
      advanceFor: (cluster) => advances.get(cluster) ?? 7.5,
    });
    expect(layout.cells(0).map((cell) => cell.x)).toEqual([
      0, 7.5, 30, 42.75, 61,
    ]);
  });

  it("does not upload a stale Content Version", () => {
    const tokenizer: Tokenizer = {
      contentChanged: () => undefined,
      wanted: () => undefined,
    };
    const uploaded: TokenizedLines[] = [];
    const uploader: GpuUploader = {
      uploadTokens: (value) => {
        uploaded.push(value);
      },
    };
    const residency = new DocumentResidency(tokenizer);
    residency.contentChanged("file", 2, "new");
    residency.receiveTokens({
      fileId: "file",
      contentVersion: 1,
      lineRange: { start: 0, end: 1 },
      runs: new Uint32Array(),
      lineRunOffsets: new Uint32Array(),
      palette: [],
    });
    residency.receiveTokens({
      fileId: "file",
      contentVersion: 2,
      lineRange: { start: 0, end: 1 },
      runs: new Uint32Array(),
      lineRunOffsets: new Uint32Array(),
      palette: [],
    });
    residency.drain(10, uploader);
    expect(uploaded.map((value) => value.contentVersion)).toEqual([2]);
  });
});
