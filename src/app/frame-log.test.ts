import { describe, expect, it } from "vitest";

import { FrameLog } from "./frame-log";

describe("FrameLog", () => {
  it("keeps the last 512 ticks in chronological order", () => {
    const log = new FrameLog();
    for (let index = 0; index < 513; index += 1) {
      log.record(
        {
          missingTile: index % 2 === 0,
          drawnTileCount: index,
          drawnLabelTileCount: index % 3,
          drawnFallbackTileCount: 0,
          drawnUnhighlightedTileCount: index % 4,
          lowestEpochDrawn: index,
          lowestContentVersion: index,
        },
        {
          cameraOffsetX: index,
          cameraOffsetY: index,
          cameraScale: index / 10,
          detailLevel: 0,
          onScreenLineHeight: index / 5,
          textReady: index % 3 === 0,
          editorVisible: false,
        },
      );
    }
    const entries = log.snapshot();
    expect(entries).toHaveLength(512);
    expect(entries[0]?.tick).toBe(1);
    expect(entries[511]?.tick).toBe(512);
    expect(entries[0]?.drawnTileCount).toBe(1);
    expect(entries[511]?.drawnTileCount).toBe(512);
    expect(entries[511]?.drawnUnhighlightedTileCount).toBe(0);
    expect(entries[511]?.timeMs).toEqual(expect.any(Number));
  });

  it("returns a copy of the typed-array log", () => {
    const log = new FrameLog();
    log.record(
      {
        missingTile: true,
        drawnTileCount: 2,
        drawnLabelTileCount: 1,
        drawnFallbackTileCount: 1,
        drawnUnhighlightedTileCount: 2,
        lowestEpochDrawn: 7,
        lowestContentVersion: 2,
      },
      {
        cameraOffsetX: 0,
        cameraOffsetY: 0,
        cameraScale: 1.37,
        detailLevel: 1,
        onScreenLineHeight: 11.1,
        textReady: true,
        editorVisible: true,
      },
    );
    const entries = log.snapshot();
    entries.pop();
    expect(log.snapshot()).toHaveLength(1);
    expect(log.snapshot()[0]?.drawnTileCount).toBe(2);
    expect(log.snapshot()[0]?.drawnLabelTileCount).toBe(1);
    expect(log.snapshot()[0]?.drawnUnhighlightedTileCount).toBe(2);
    expect(log.snapshot()[0]?.timeMs).toEqual(expect.any(Number));
    expect(log.snapshot()[0]?.tick).toBe(0);
    expect(log.snapshot()[0]?.onScreenLineHeight).toBe(11.1);
    expect(log.snapshot()[0]?.textReady).toBe(true);
  });
});
