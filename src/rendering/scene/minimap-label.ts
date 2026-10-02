import type { FontDefinition } from "../../shared/font";
import type { RasterCellInput } from "../text/raster-job";

export const MINIMAP_LABEL_MIN_FONT_SIZE = 9;
export const MINIMAP_LABEL_MAX_FONT_SIZE = 28;

interface MinimapLabelMetrics {
  readonly baseFontSize: number;
  readonly advanceFor: (cluster: string) => number;
}

export interface MinimapLabelLayout {
  readonly text: string;
  readonly fontSize: number;
  readonly textWidth: number;
  readonly padding: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
  readonly lineHeight: number;
}

interface MinimapLabelRasterJob {
  readonly cells: readonly RasterCellInput[];
  readonly font: string;
  readonly baseline: number;
  readonly lineHeight: number;
  readonly originY: number;
  readonly backgroundColor: string;
  readonly palette: readonly string[];
  readonly outlineColor: string;
  readonly outlineWidth: number;
}

interface LabelLayoutInput extends MinimapLabelMetrics {
  readonly filePath: string;
  readonly widgetWidth: number;
  readonly widgetHeight: number;
  readonly padding: number;
  readonly baseBaseline: number;
  readonly baseLineHeight: number;
}

export function layoutMinimapLabel(
  input: LabelLayoutInput,
): MinimapLabelLayout {
  const availableWidth = Math.max(0, input.widgetWidth - 2 * input.padding);
  const path = input.filePath;
  const fileName = lastPathSegment(path);
  const pathWidth = widthAtFontSize(path, input, MINIMAP_LABEL_MIN_FONT_SIZE);
  if (pathWidth <= availableWidth) {
    return finishLayout(path, pathWidth, input);
  }
  const fileNameWidth = widthAtFontSize(
    fileName,
    input,
    MINIMAP_LABEL_MIN_FONT_SIZE,
  );
  if (fileNameWidth <= availableWidth) {
    return finishLayout(fileName, fileNameWidth, input);
  }
  const text = ellipsize(fileName, availableWidth, input);
  const textWidth = widthAtFontSize(text, input, MINIMAP_LABEL_MIN_FONT_SIZE);
  const width = textWidth + 2 * input.padding;
  const vertical = verticalMetrics(MINIMAP_LABEL_MIN_FONT_SIZE, input);
  return {
    text,
    fontSize: MINIMAP_LABEL_MIN_FONT_SIZE,
    textWidth,
    padding: input.padding,
    x: (input.widgetWidth - width) / 2,
    y: (input.widgetHeight - vertical.height) / 2,
    width,
    ...vertical,
  };
}

interface MinimapLabelRasterInput {
  readonly layout: MinimapLabelLayout;
  readonly zoom: number;
  readonly font: Pick<FontDefinition, "family">;
  readonly fillColor: string;
  readonly outlineColor?: string;
}

export function buildMinimapLabelRasterJob(
  input: MinimapLabelRasterInput,
): MinimapLabelRasterJob {
  const { layout, zoom, font, fillColor } = input;
  const outlineColor = input.outlineColor ?? "#10141f";
  const safeZoom = Math.max(Number.EPSILON, zoom);
  const worldFontSize = layout.fontSize / safeZoom;
  const outlineWidth = Math.min(
    1.5,
    layout.baseline,
    layout.lineHeight - layout.baseline,
  );
  return {
    cells: [
      {
        cluster: layout.text,
        x: layout.padding / safeZoom,
        line: 0,
        colorIndex: 0,
      },
    ],
    font: `${String(worldFontSize)}px ${font.family}`,
    baseline: layout.baseline / safeZoom,
    lineHeight: layout.lineHeight / safeZoom,
    originY: 0,
    backgroundColor: "transparent",
    palette: [fillColor],
    outlineColor,
    outlineWidth: outlineWidth / safeZoom,
  };
}

function finishLayout(
  text: string,
  textWidthAtMinSize: number,
  input: LabelLayoutInput,
): MinimapLabelLayout {
  const availableWidth = Math.max(0, input.widgetWidth - 2 * input.padding);
  const availableHeight = Math.max(0, input.widgetHeight - 2 * input.padding);
  const widthFontSize =
    ((availableWidth * input.baseFontSize) / textWidthAtMinSize) *
    (MINIMAP_LABEL_MIN_FONT_SIZE / input.baseFontSize);
  const heightFontSize =
    (availableHeight * input.baseFontSize) / input.baseLineHeight;
  const fontSize = Math.min(
    MINIMAP_LABEL_MAX_FONT_SIZE,
    Math.max(
      MINIMAP_LABEL_MIN_FONT_SIZE,
      Math.min(widthFontSize, heightFontSize),
    ),
  );
  const textWidth = widthAtFontSize(text, input, fontSize);
  const width = textWidth + 2 * input.padding;
  const vertical = verticalMetrics(fontSize, input);
  return {
    text,
    fontSize,
    textWidth,
    padding: input.padding,
    x: (input.widgetWidth - width) / 2,
    y: (input.widgetHeight - vertical.height) / 2,
    width,
    ...vertical,
  };
}

function verticalMetrics(
  fontSize: number,
  input: LabelLayoutInput,
): Pick<MinimapLabelLayout, "height" | "baseline" | "lineHeight"> {
  const scale = fontSize / input.baseFontSize;
  return {
    height: input.baseLineHeight * scale,
    baseline: input.baseBaseline * scale,
    lineHeight: input.baseLineHeight * scale,
  };
}

function widthAtFontSize(
  text: string,
  metrics: MinimapLabelMetrics,
  fontSize: number,
): number {
  let width = 0;
  for (const cluster of Array.from(text)) width += metrics.advanceFor(cluster);
  return width * (fontSize / metrics.baseFontSize);
}

function lastPathSegment(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(slash + 1) || path;
}

function ellipsize(
  text: string,
  availableWidth: number,
  metrics: LabelLayoutInput,
): string {
  const ellipsis = "…";
  if (
    widthAtFontSize(ellipsis, metrics, MINIMAP_LABEL_MIN_FONT_SIZE) >
    availableWidth
  )
    return ellipsis;
  let prefix = "";
  for (const cluster of Array.from(text)) {
    const candidate = `${prefix}${cluster}${ellipsis}`;
    if (
      widthAtFontSize(candidate, metrics, MINIMAP_LABEL_MIN_FONT_SIZE) >
      availableWidth
    )
      break;
    prefix += cluster;
  }
  return `${prefix}${ellipsis}`;
}
