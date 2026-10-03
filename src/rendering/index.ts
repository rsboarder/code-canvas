export { FrameLoop } from "./frame-loop";
export { worldToClip } from "./clip-transform";
export type { ClipPoint, WorldToClipInput } from "./clip-transform";
export { minimapUvY } from "./minimap-uv";
export type { Viewport } from "./viewport";
export { GpuUploaderAdapter } from "./scene/gpu-uploader";
export {
  MAX_WIDGET_ROWS,
  WidgetTable,
  type WidgetId,
  type WidgetTableBoard,
} from "./scene/widget-table";
export {
  calculateBaseline,
  createAdvanceCache,
  createTextMetrics,
  isWhitespaceCluster,
  roundMetric,
} from "./text/text-metrics";
export type {
  CodeTextMetrics,
  TextMetricsProbe,
  TextMetricsProbeLine,
} from "./text/text-metrics";
export { WebGlRenderer } from "./webgl-renderer";
