import type {
  EncodedRasterCells,
  RasterCellInput,
  RasterJob,
} from "../text/raster-job";
import { encodeRasterCells } from "../text/raster-job";
import {
  HEADER_KIND,
  LABEL_KIND,
  type TileRecordView,
  TileRecords,
} from "./widget-tile-set/tile-records";
import { TILE_DEVICE_SIZE, tileContentSize } from "./tile-plan";
import { TILE_CELL_HEIGHT } from "./tile-pool";

export interface TileContentSource {
  readonly fileId: string;
  readonly filePath: string;
  readonly hasText: boolean;
  readonly contentVersion: number;
  readonly highlighted: boolean;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly palette: readonly string[];
  readonly baseline: number;
  readonly lineHeight: number;
  readonly backgroundColor: string;
  readonly headerBackgroundColor: string;
  cellsFor(
    column: number,
    row: number,
    rasterScale: number,
  ): EncodedRasterCells;
  headerCellsFor(column: number, rasterScale: number): EncodedRasterCells;
  readonly label?: TileLabelContentSource;
}

export interface TileLabelContentSource {
  readonly identity: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  jobFor(rasterScale: number): {
    readonly cells: readonly RasterCellInput[];
    readonly font: string;
    readonly baseline: number;
    readonly lineHeight: number;
    readonly originY: number;
    readonly backgroundColor: string;
    readonly palette: readonly string[];
    readonly outlineColor: string;
    readonly outlineWidth: number;
  };
}

type WritableRasterJob = {
  -readonly [Key in keyof RasterJob]: RasterJob[Key];
};

const RECORD_VIEW: TileRecordView = {
  key: undefined,
  active: false,
  ready: false,
  pending: false,
  kind: 0,
  rasterScale: 1,
  epoch: 0,
  contentVersion: -1,
  column: 0,
  row: 0,
  localX: 0,
  localY: 0,
  width: 0,
  height: 0,
  highlighted: false,
};

export function writeTileKindJob(
  source: TileContentSource,
  records: TileRecords,
  record: number,
  job: WritableRasterJob,
): boolean {
  records.read(record, RECORD_VIEW);
  const kind = RECORD_VIEW.kind;
  if (kind === LABEL_KIND) return writeLabelJob(source, records, record, job);
  const rasterScale = RECORD_VIEW.rasterScale;
  const column = RECORD_VIEW.column;
  const row = RECORD_VIEW.row;
  job.backgroundColor =
    kind === HEADER_KIND
      ? source.headerBackgroundColor
      : source.backgroundColor;
  job.palette = source.palette;
  job.baseline = source.baseline;
  job.lineHeight = source.lineHeight;
  job.originY = kind === HEADER_KIND ? 0 : row * tileContentSize(rasterScale);
  job.outlineColor = "";
  job.outlineWidth = 0;
  job.width = TILE_DEVICE_SIZE;
  job.height = usesCell(records, record) ? TILE_CELL_HEIGHT : TILE_DEVICE_SIZE;
  job.cells =
    kind === HEADER_KIND
      ? source.headerCellsFor(column, rasterScale)
      : source.cellsFor(column, row, rasterScale);
  return true;
}

export function usesCell(records: TileRecords, record: number): boolean {
  records.read(record, RECORD_VIEW);
  const kind = RECORD_VIEW.kind;
  if (kind !== HEADER_KIND && kind !== LABEL_KIND) return false;
  const rasterScale = RECORD_VIEW.rasterScale;
  return (
    RECORD_VIEW.height * rasterScale <= TILE_CELL_HEIGHT - 1 &&
    RECORD_VIEW.width * rasterScale <= TILE_DEVICE_SIZE
  );
}

function writeLabelJob(
  source: TileContentSource,
  records: TileRecords,
  record: number,
  job: WritableRasterJob,
): boolean {
  records.read(record, RECORD_VIEW);
  const rasterScale = RECORD_VIEW.rasterScale;
  const labelJob = source.label?.jobFor(rasterScale);
  if (!labelJob) return false;
  job.backgroundColor = labelJob.backgroundColor;
  job.palette = labelJob.palette;
  job.font = labelJob.font;
  job.baseline = labelJob.baseline;
  job.lineHeight = labelJob.lineHeight;
  job.originY = labelJob.originY;
  job.outlineColor = labelJob.outlineColor;
  job.outlineWidth = labelJob.outlineWidth;
  job.width = TILE_DEVICE_SIZE;
  job.height = usesCell(records, record) ? TILE_CELL_HEIGHT : TILE_DEVICE_SIZE;
  job.cells = encodeRasterCells(labelJob.cells);
  return true;
}
