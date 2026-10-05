import type { LineWindow } from "../code-view/index";
import type { TileDebugSnapshot } from "./scene/tile-residency";

export interface RenderingProbeSource {
  readonly lineWindows: ReadonlyMap<string, LineWindow>;
  readonly baseline: number;
  readonly tileDebug: (fileId?: string) => TileDebugSnapshot;
}
