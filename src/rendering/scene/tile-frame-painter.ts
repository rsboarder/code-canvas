import { TilePass, type TileInstance } from "../passes/tile-pass";
import { recordDrawMetrics, type FrameDrawMetrics } from "./frame-draw-metrics";
import { TilePool } from "./tile-pool";
import { tileContentSize } from "./tile-plan";
import { CONTENT_KIND, HEADER_KIND, TileRecords } from "./tile-records";
import { TileSetPlanner } from "./tile-sets";

interface TileFramePainterConfig {
  readonly tilePass: TilePass;
  readonly pool: TilePool;
  readonly tileRecords: TileRecords;
  readonly planner: TileSetPlanner;
  readonly metrics: FrameDrawMetrics;
}

export class TileFramePainter {
  private readonly tileInstance: TileInstance = {
    localX: 0,
    localY: 0,
    width: 0,
    height: 0,
    layer: 0,
    uvMaxX: 0,
    uvMaxY: 0,
  };

  private readonly drawnTile = {
    content: false,
    fallback: false,
    highlighted: false,
    epoch: -1,
    contentVersion: -1,
  };

  private bodyTopCss = 0;

  private readonly tilePass: TilePass;

  private readonly pool: TilePool;

  private readonly tileRecords: TileRecords;

  private readonly planner: TileSetPlanner;

  private readonly metrics: FrameDrawMetrics;

  constructor(config: TileFramePainterConfig) {
    this.tilePass = config.tilePass;
    this.pool = config.pool;
    this.tileRecords = config.tileRecords;
    this.planner = config.planner;
    this.metrics = config.metrics;
  }

  setBodyTopCss(bodyTopCss: number): void {
    this.bodyTopCss = bodyTopCss;
  }

  draw(detailIsMinimap: boolean): void {
    if (detailIsMinimap) this.pushMinimapLabel();
    else this.pushHeaderInstances();
    this.tilePass.markTitleBoundary();
    if (!detailIsMinimap) this.pushContentInstances();
  }

  private pushHeaderInstances(): void {
    for (
      let index = 0;
      index < this.planner.drawHeaderFallbackCount;
      index += 1
    ) {
      const record = this.planner.drawHeaderFallback[index] ?? -1;
      if (record >= 0) this.pushRecord(record, true);
    }
    for (
      let index = 0;
      index < this.planner.drawHeaderCurrentCount;
      index += 1
    ) {
      const record = this.planner.drawHeaderCurrent[index] ?? -1;
      if (record >= 0) this.pushRecord(record, false);
    }
  }

  private pushContentInstances(): void {
    for (let index = 0; index < this.planner.drawFallbackCount; index += 1) {
      const record = this.planner.drawFallback[index] ?? -1;
      if (record >= 0) this.pushRecord(record, true);
    }
    for (let index = 0; index < this.planner.drawCurrentCount; index += 1) {
      const record = this.planner.drawCurrent[index] ?? -1;
      if (record >= 0) this.pushRecord(record, false);
    }
  }

  private pushRecord(record: number, fallback: boolean): void {
    const key = this.tileRecords.keys[record];
    if (!key || !this.tileRecords.records.ready[record]) return;
    const layer = this.pool.layerFor(key);
    if (layer === undefined) return;
    this.setTileInstance(record, layer);
    this.tilePass.pushTileInstance(this.tileInstance);
    this.drawnTile.content =
      this.tileRecords.records.kind[record] === CONTENT_KIND;
    this.drawnTile.fallback = fallback;
    this.drawnTile.highlighted = this.tileRecords.highlighted[record] === 1;
    this.drawnTile.epoch = this.tileRecords.records.epoch[record] ?? -1;
    this.drawnTile.contentVersion = this.drawnTile.content
      ? (this.tileRecords.records.contentVersion[record] ?? -1)
      : -1;
    recordDrawMetrics(this.metrics, this.drawnTile);
  }

  private pushMinimapLabel(): void {
    for (
      let index = 0;
      index < this.planner.drawLabelFallbackCount;
      index += 1
    ) {
      const record = this.planner.drawLabelFallback[index] ?? -1;
      if (record >= 0) this.pushRecord(record, true);
    }
    for (
      let index = 0;
      index < this.planner.drawLabelCurrentCount;
      index += 1
    ) {
      const record = this.planner.drawLabelCurrent[index] ?? -1;
      if (record >= 0) this.pushRecord(record, false);
    }
  }

  private setTileInstance(record: number, layer: number): void {
    const rasterScale = this.tileRecords.records.rasterScale[record] ?? 1;
    const size = tileContentSize(rasterScale);
    this.tileInstance.localX = this.tileRecords.records.localX[record] ?? 0;
    this.tileInstance.localY =
      (this.tileRecords.records.localY[record] ?? 0) +
      (this.tileRecords.records.kind[record] === HEADER_KIND
        ? 0
        : this.bodyTopCss);
    this.tileInstance.width = this.tileRecords.records.width[record] ?? 0;
    this.tileInstance.height = this.tileRecords.records.height[record] ?? 0;
    this.tileInstance.layer = layer;
    this.tileInstance.uvMaxX = this.tileInstance.width / size;
    this.tileInstance.uvMaxY = this.tileInstance.height / size;
  }
}
