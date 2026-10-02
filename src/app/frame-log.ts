interface FrameLogEntry {
  readonly tick: number;
  readonly timeMs: number;
  readonly missingTile: boolean;
  readonly drawnTileCount: number;
  readonly drawnLabelTileCount: number;
  readonly drawnFallbackTileCount: number;
  readonly drawnUnhighlightedTileCount: number;
  readonly lowestEpochDrawn: number;
  readonly lowestContentVersion: number;
  readonly editorVisible: boolean;
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
  readonly detailLevel: 0 | 1;
  readonly onScreenLineHeight: number;
  readonly textReady: boolean;
}

interface FrameLogMetrics {
  readonly missingTile: boolean;
  readonly drawnTileCount: number;
  readonly drawnLabelTileCount: number;
  readonly drawnFallbackTileCount: number;
  readonly drawnUnhighlightedTileCount: number;
  readonly lowestEpochDrawn: number;
  readonly lowestContentVersion: number;
}

interface FrameLogView {
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
  readonly detailLevel: 0 | 1;
  readonly onScreenLineHeight: number;
  readonly textReady: boolean;
  readonly editorVisible: boolean;
}

const CAPACITY = 512;

export class FrameLog {
  private readonly tick = new Float64Array(CAPACITY);
  private readonly timeMs = new Float64Array(CAPACITY);
  private readonly missingTile = new Uint8Array(CAPACITY);
  private readonly drawnTileCount = new Uint16Array(CAPACITY);
  private readonly drawnLabelTileCount = new Uint16Array(CAPACITY);
  private readonly drawnFallbackTileCount = new Uint16Array(CAPACITY);
  private readonly drawnUnhighlightedTileCount = new Uint16Array(CAPACITY);
  private readonly lowestEpochDrawn = new Int32Array(CAPACITY);
  private readonly lowestContentVersion = new Int32Array(CAPACITY);
  private readonly editorVisible = new Uint8Array(CAPACITY);
  private readonly cameraOffsetX = new Float64Array(CAPACITY);
  private readonly cameraOffsetY = new Float64Array(CAPACITY);
  private readonly cameraScale = new Float64Array(CAPACITY);
  private readonly detailLevel = new Uint8Array(CAPACITY);
  private readonly onScreenLineHeight = new Float64Array(CAPACITY);
  private readonly textReady = new Uint8Array(CAPACITY);
  private writeIndex = 0;
  private count = 0;
  private nextTick = 0;

  record(metrics: FrameLogMetrics, view: FrameLogView): void {
    const index = this.writeIndex;
    this.tick[index] = this.nextTick;
    this.timeMs[index] = performance.now();
    this.nextTick += 1;
    this.missingTile[index] = metrics.missingTile ? 1 : 0;
    this.drawnTileCount[index] = metrics.drawnTileCount;
    this.drawnLabelTileCount[index] = metrics.drawnLabelTileCount;
    this.drawnFallbackTileCount[index] = metrics.drawnFallbackTileCount;
    this.drawnUnhighlightedTileCount[index] =
      metrics.drawnUnhighlightedTileCount;
    this.lowestEpochDrawn[index] = metrics.lowestEpochDrawn;
    this.lowestContentVersion[index] = metrics.lowestContentVersion;
    this.editorVisible[index] = view.editorVisible ? 1 : 0;
    this.cameraOffsetX[index] = view.cameraOffsetX;
    this.cameraOffsetY[index] = view.cameraOffsetY;
    this.cameraScale[index] = view.cameraScale;
    this.detailLevel[index] = view.detailLevel;
    this.onScreenLineHeight[index] = view.onScreenLineHeight;
    this.textReady[index] = view.textReady ? 1 : 0;
    this.writeIndex = (index + 1) % CAPACITY;
    this.count = Math.min(CAPACITY, this.count + 1);
  }

  snapshot(): FrameLogEntry[] {
    const entries: FrameLogEntry[] = [];
    const first = (this.writeIndex - this.count + CAPACITY) % CAPACITY;
    for (let offset = 0; offset < this.count; offset += 1) {
      const index = (first + offset) % CAPACITY;
      entries.push({
        tick: this.tick[index] ?? 0,
        timeMs: this.timeMs[index] ?? 0,
        missingTile: this.missingTile[index] === 1,
        drawnTileCount: this.drawnTileCount[index] ?? 0,
        drawnLabelTileCount: this.drawnLabelTileCount[index] ?? 0,
        drawnFallbackTileCount: this.drawnFallbackTileCount[index] ?? 0,
        drawnUnhighlightedTileCount:
          this.drawnUnhighlightedTileCount[index] ?? 0,
        lowestEpochDrawn: this.lowestEpochDrawn[index] ?? -1,
        lowestContentVersion: this.lowestContentVersion[index] ?? -1,
        editorVisible: this.editorVisible[index] === 1,
        cameraOffsetX: this.cameraOffsetX[index] ?? 0,
        cameraOffsetY: this.cameraOffsetY[index] ?? 0,
        cameraScale: this.cameraScale[index] ?? 0,
        detailLevel: this.detailLevel[index] === 1 ? 1 : 0,
        onScreenLineHeight: this.onScreenLineHeight[index] ?? 0,
        textReady: this.textReady[index] === 1,
      });
    }
    return entries;
  }
}
