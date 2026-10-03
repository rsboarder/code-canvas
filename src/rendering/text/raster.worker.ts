// The Text Tiles raster worker (design D6 "Raster workers", D14 "workers are
// module scripts from the bundle"): rasterizes one tile's background and
// cells with Canvas2D, exactly as `drawRasterCells` did in spike H
// (`spikes/h/renderer.ts`), and returns a transferable `ImageBitmap`. Loaded
// the same way as the tokenizer worker (`new Worker(new URL(...,
// import.meta.url), { type: "module" })` — never a `blob:` worker).
import { DEFAULT_CODE_FONT } from "../../shared/font";
import { decodeRasterCells } from "./raster-job";
import type {
  RasterResult,
  RasterWorkerRequest,
  RasterWorkerResponse,
} from "./raster-job";
import { configureCanvasFont, PROBE_CHARACTER } from "./text-metrics";

const workerGlobal = self as unknown as {
  onmessage: ((event: MessageEvent<RasterWorkerRequest>) => void) | null;
  postMessage(message: RasterWorkerResponse, transfer: Transferable[]): void;
};

function reportFontCheck(): void {
  const probeCanvas = new OffscreenCanvas(8, 8);
  const context = probeCanvas.getContext("2d");
  if (!context) return;
  configureCanvasFont(context, DEFAULT_CODE_FONT);
  const measuredNarrowAdvance = context.measureText(PROBE_CHARACTER).width;
  workerGlobal.postMessage({ type: "fontCheck", measuredNarrowAdvance }, []);
}

function drawCells(
  context: OffscreenCanvasRenderingContext2D,
  request: RasterWorkerRequest,
): void {
  const { job } = request;
  context.textBaseline = "alphabetic";
  context.font = job.font;
  decodeRasterCells(job.cells).forEach((cell) => {
    context.fillStyle =
      job.palette[cell.colorIndex] ?? job.palette[0] ?? "#000";
    const y = cell.line * job.lineHeight - job.originY + job.baseline;
    if (job.outlineWidth > 0) {
      context.strokeStyle = job.outlineColor;
      context.lineWidth = job.outlineWidth;
      context.lineJoin = "round";
      context.strokeText(cell.cluster, cell.x, y);
    }
    context.fillText(cell.cluster, cell.x, y);
  });
}

async function rasterTile(request: RasterWorkerRequest): Promise<void> {
  const { job } = request;
  const canvas = new OffscreenCanvas(job.width, job.height);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = job.backgroundColor;
  context.fillRect(0, 0, job.width, job.height);
  context.scale(job.rasterScale, job.rasterScale);
  drawCells(context, request);
  const bitmap = await createImageBitmap(canvas);
  const result: RasterResult = {
    tileKey: job.tileKey,
    contentVersion: job.contentVersion,
    rasterScale: job.rasterScale,
    bitmap,
  };
  workerGlobal.postMessage({ type: "rasterResult", result }, [bitmap]);
}

function reportRasterFailure(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  workerGlobal.postMessage(
    { type: "rasterError", message: `Raster worker failed: ${detail}` },
    [],
  );
}

// Only one request kind exists today (`raster`); `RasterWorkerRequest` stays
// a union so a future job kind doesn't need to touch this call site.
workerGlobal.onmessage = (event) => {
  void rasterTile(event.data).catch(reportRasterFailure);
};

reportFontCheck();
