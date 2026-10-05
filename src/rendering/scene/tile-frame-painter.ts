import { TilePass, type TileInstance } from "../passes/tile-pass";
import { recordDrawMetrics, type FrameDrawMetrics } from "./frame-draw-metrics";
import { TilePool, type TilePoolRegion } from "./tile-pool";
import { tileContentSize } from "./tile-plan";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  type TileRecordView,
  type WidgetTiles,
} from "./widget-tile-set";

interface TileFramePainterConfig {
  readonly tilePass: TilePass;
  readonly pool: TilePool;
  readonly metrics: FrameDrawMetrics;
}

export interface TileFramePaintInput {
  readonly widgets: readonly WidgetTiles[];
  count: number;
  detailIsMinimap: boolean;
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
  };

  private bodyTopCss = 0;
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
      widget.drawRecords(HEADER_KIND, true),
      widget.drawRecordCount(HEADER_KIND, true),
      true,
    );
    this.pushRecords(
      widget,
      widget.drawRecords(HEADER_KIND, false),
      widget.drawRecordCount(HEADER_KIND, false),
      false,
    );
  }

  private pushContentInstances(widget: WidgetTiles): void {
    this.pushRecords(
      widget,
      widget.drawRecords(CONTENT_KIND, true),
      widget.drawRecordCount(CONTENT_KIND, true),
      true,
    );
    this.pushRecords(
      widget,
      widget.drawRecords(CONTENT_KIND, false),
      widget.drawRecordCount(CONTENT_KIND, false),
      false,
    );
  }

  private pushMinimapLabel(widget: WidgetTiles): void {
    this.pushRecords(
      widget,
      widget.drawRecords(LABEL_KIND, true),
      widget.drawRecordCount(LABEL_KIND, true),
      true,
    );
    this.pushRecords(
      widget,
      widget.drawRecords(LABEL_KIND, false),
      widget.drawRecordCount(LABEL_KIND, false),
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
    const view = widget.readRecord(record);
    const key = view.key;
    if (!key || !view.ready) return;
    if (!this.pool.regionFor(key, this.region)) return;
    this.setTileInstance(widget, view, this.region);
    this.tilePass.pushTileInstance(this.tileInstance);
    this.drawnTile.content = view.kind === CONTENT_KIND;
    this.drawnTile.fallback = fallback;
    this.drawnTile.highlighted = view.highlighted;
    this.drawnTile.epoch = view.epoch;
    this.drawnTile.contentVersion = this.drawnTile.content
      ? view.contentVersion
      : -1;
    recordDrawMetrics(this.metrics, this.drawnTile);
  }

  private setTileInstance(
    widget: WidgetTiles,
    record: TileRecordView,
    region: TilePoolRegion,
  ): void {
    const rasterScale = record.rasterScale;
    const size = tileContentSize(rasterScale);
    const kind = record.kind;
    this.tileInstance.localX = record.localX;
    this.tileInstance.localY =
      record.localY +
      (kind === HEADER_KIND ? 0 : kind === CONTENT_KIND ? 0 : this.bodyTopCss);
    this.tileInstance.width = record.width;
    this.tileInstance.height = record.height;
    this.tileInstance.uvMaxX = this.tileInstance.width / size;
    this.tileInstance.uvMaxY = this.tileInstance.height / size;
    this.tileInstance.widgetRow = widget.row;
    this.tileInstance.region =
      kind === CONTENT_KIND ? 0 : kind === HEADER_KIND ? 1 : LABEL_KIND;
    this.tileInstance.uvOffsetX = region.uvOffsetX;
    this.tileInstance.uvOffsetY = region.uvOffsetY;
  }
}
