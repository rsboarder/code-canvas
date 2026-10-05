import type { BoardService } from "../board";
import type { WebGlRenderer } from "../rendering";

export function syncDetailLevel(
  board: BoardService,
  renderer: WebGlRenderer | undefined,
  canvas: HTMLCanvasElement,
) {
  const devicePixelRatio = window.devicePixelRatio || 1;
  const level = board.updateDetailLevel(
    devicePixelRatio,
    renderer?.textReady() ?? false,
  );
  if (canvas.getAttribute("data-detail-level") !== level) {
    canvas.setAttribute("data-detail-level", level);
  }
  renderer?.setDetailLevel(level, board.textWanted(devicePixelRatio));
  return level;
}
