import { expect, type Page } from "@playwright/test";

export interface FrameLogEntry {
  readonly tick: number;
  readonly timeMs: number;
  readonly missingTile: boolean;
  readonly drawnTileCount: number;
  readonly drawnLabelTileCount: number;
  readonly drawnUnhighlightedTileCount: number;
  readonly lowestContentVersion: number;
  readonly editorVisible: boolean;
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
}

export async function readFrameLog(
  page: Page,
): Promise<readonly FrameLogEntry[]> {
  return page.evaluate(() => {
    const entries = window.__codeCanvasTest?.frameLog();
    if (!entries) throw new Error("Code Canvas frame log is missing");
    return entries;
  });
}

export async function lastFrameTick(page: Page): Promise<number> {
  const entries = await readFrameLog(page);
  return entries[entries.length - 1]?.tick ?? -1;
}

export async function waitForFrame(
  page: Page,
  predicate: (entry: FrameLogEntry) => boolean,
): Promise<FrameLogEntry> {
  let match: FrameLogEntry | undefined;
  await expect
    .poll(
      async () => {
        match = (await readFrameLog(page)).find(predicate);
        return match?.tick ?? -1;
      },
      { timeout: 3000 },
    )
    .not.toBe(-1);
  if (!match) throw new Error("Expected frame-log entry is missing");
  return match;
}

export async function assertHeldExitFrames(
  page: Page,
  startTick: number,
  contentVersion: number,
): Promise<void> {
  const entries = (await readFrameLog(page)).filter(
    (entry) => entry.tick >= startTick,
  );
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(
      entry.lowestContentVersion === -1 ||
        entry.lowestContentVersion >= contentVersion,
    ).toBe(true);
    expect(entry.missingTile).toBe(false);
    expect(entry.editorVisible || entry.drawnTileCount > 0).toBe(true);
    expect(entry.drawnLabelTileCount).toBeGreaterThan(0);
  }
  const editingEntries = entries.filter((entry) => entry.editorVisible);
  const stationary = editingEntries[0];
  if (!stationary) throw new Error("No held editing frame was logged");
  for (const entry of editingEntries) {
    expect(entry.cameraOffsetX).toBe(stationary.cameraOffsetX);
    expect(entry.cameraOffsetY).toBe(stationary.cameraOffsetY);
    expect(entry.cameraScale).toBe(stationary.cameraScale);
  }
}
