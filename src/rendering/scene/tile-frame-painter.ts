import { TilePass, type TileInstance } from "../passes/tile-pass";
import { recordDrawMetrics, type FrameDrawMetrics } from "./frame-draw-metrics";
import { TilePool, type TilePoolRegion } from "./tile-pool";
import { tileContentSize } from "./tile-plan";
import { CONTENT_KIND, HEADER_KIND, LABEL_KIND } from "./tile-records";
import type { WidgetTiles } from "./widget-tiles";

interface TileFramePainterConfig {
  readonly tilePass: TilePass;
  readonly pool: TilePool;
  readonly metrics: FrameDrawMetrics;
}

export interface TileFramePaintInput {
  readonly widgets: readonly WidgetTiles[];
  count: number;
  detailIsMinimap: boolean;
  documentId: string;
  hiddenBodyId: string | undefined;
}

export class TileFramePainter {
  private readonly tileInstance: TileInstance = {
    localX: 0,
    localY: 0,
    width: 0,
    height: 0,
    uvMaxX: 0,
    uvMaxY: 0,
    widgetRow: -1,
    region: 0,
    uvOffsetX: 0,
    uvOffsetY: 0,
  };

  private readonly drawnTile = {
    content: false,
    fallback: false,
    highlighted: false,
    epoch: -1,
    contentVersion: -1,
    document: false,
  };

  private bodyTopCss = 0;
  private documentId = "";
  private readonly tilePass: TilePass;
  private readonly pool: TilePool;
  private readonly metrics: FrameDrawMetrics;
  private readonly region: TilePoolRegion = {
    uvOffsetX: 0,
    uvOffsetY: 0,
  };

  constructor(config: TileFramePainterConfig) {
    this.tilePass = config.tilePass;
    this.pool = config.pool;
    this.metrics = config.metrics;
  }

  setBodyTopCss(bodyTopCss: number): void {
    this.bodyTopCss = bodyTopCss;
  }

  draw(input: TileFramePaintInput): void {
    this.documentId = input.documentId;
    for (let index = 0; index < input.count; index += 1) {
      const widget = input.widgets[index];
      if (!widget) continue;
      this.pushHeaderInstances(widget);
      if (input.detailIsMinimap) this.pushMinimapLabel(widget);
    }
    this.tilePass.markTitleBoundary();
    if (input.detailIsMinimap) return;
    for (let index = 0; index < input.count; index += 1) {
      const widget = input.widgets[index];
      if (!widget || widget.fileId === input.hiddenBodyId) continue;
      this.pushContentInstances(widget);
    }
  }

  private pushHeaderInstances(widget: WidgetTiles): void {
    this.pushRecords(
      widget,
      widget.planner.drawHeaderFallback,
      widget.planner.drawHeaderFallbackCount,
      true,
    );
    this.pushRecords(
      widget,
      widget.planner.drawHeaderCurrent,
      widget.planner.drawHeaderCurrentCount,
      false,
    );
  }

  private pushContentInstances(widget: WidgetTiles): void {
    this.pushRecords(
      widget,
      widget.planner.drawFallback,
      widget.planner.drawFallbackCount,
      true,
    );
    this.pushRecords(
      widget,
      widget.planner.drawCurrent,
      widget.planner.drawCurrentCount,
      false,
    );
  }

  private pushMinimapLabel(widget: WidgetTiles): void {
    this.pushRecords(
      widget,
      widget.planner.drawLabelFallback,
      widget.planner.drawLabelFallbackCount,
      true,
    );
    this.pushRecords(
      widget,
      widget.planner.drawLabelCurrent,
      widget.planner.drawLabelCurrentCount,
      false,
    );
  }

  private pushRecords(
    widget: WidgetTiles,
    records: Int32Array,
    count: number,
    fallback: boolean,
  ): void {
    for (let index = 0; index < count; index += 1) {
      const record = records[index] ?? -1;
      if (record >= 0) this.pushRecord(widget, record, fallback);
    }
  }

  private pushRecord(
    widget: WidgetTiles,
    record: number,
    fallback: boolean,
  ): void {
    const key = widget.records.keys[record];
    if (!key || !widget.records.records.ready[record]) return;
    if (!this.pool.regionFor(key, this.region)) return;
    this.setTileInstance(widget, record, this.region);
    this.tilePass.pushTileInstance(this.tileInstance);
    this.drawnTile.content =
      widget.records.records.kind[record] === CONTENT_KIND;
    this.drawnTile.fallback = fallback;
    this.drawnTile.highlighted = widget.records.highlighted[record] === 1;
    this.drawnTile.epoch = widget.records.records.epoch[record] ?? -1;
    this.drawnTile.contentVersion = this.drawnTile.content
      ? (widget.records.records.contentVersion[record] ?? -1)
      : -1;
    this.drawnTile.document = widget.fileId === this.documentId;
    recordDrawMetrics(this.metrics, this.drawnTile);
  }

  private setTileInstance(
    widget: WidgetTiles,
    record: number,
    region: TilePoolRegion,
  ): void {
    const records = widget.records.records;
    const rasterScale = records.rasterScale[record] ?? 1;
    const size = tileContentSize(rasterScale);
    const kind = records.kind[record];
    this.tileInstance.localX = records.localX[record] ?? 0;
    this.tileInstance.localY =
      (records.localY[record] ?? 0) +
      (kind === HEADER_KIND ? 0 : kind === CONTENT_KIND ? 0 : this.bodyTopCss);
    this.tileInstance.width = records.width[record] ?? 0;
    this.tileInstance.height = records.height[record] ?? 0;
    this.tileInstance.uvMaxX = this.tileInstance.width / size;
    this.tileInstance.uvMaxY = this.tileInstance.height / size;
    this.tileInstance.widgetRow = widget.row;
    this.tileInstance.region =
      kind === CONTENT_KIND ? 0 : kind === HEADER_KIND ? 1 : LABEL_KIND;
    this.tileInstance.uvOffsetX = region.uvOffsetX;
    this.tileInstance.uvOffsetY = region.uvOffsetY;
  }
}
