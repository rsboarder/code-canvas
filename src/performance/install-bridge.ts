import type { FrameStats } from "./frame-stats";
import { countLongIntervals, nearestRank } from "./frame-statistics";
import type { PerfBridge, PerfFile } from "./bridge";
import { createInMemoryDirectory } from "./file-system-access-mock";

interface HarnessCameraTelemetry {
  camera: PerfBridge["camera"];
  cameraRange: PerfBridge["cameraRange"];
  resetCameraRange(): void;
}

export function installPerfBridge(
  frameStats: FrameStats,
  setCamera: PerfBridge["setCamera"],
  cameraTelemetry: HarnessCameraTelemetry,
  setSyntheticLoad: PerfBridge["setSyntheticLoad"],
): void {
  const bridge: PerfBridge = {
    snapshot: () => frameStats.snapshot(),
    reset: () => {
      frameStats.reset();
      cameraTelemetry.resetCameraRange();
    },
    nearestRank,
    countLongIntervals,
    openFolder: (files: readonly PerfFile[]) => {
      const directory = createInMemoryDirectory(files);
      const browserWindow = window as Window & {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
      };
      browserWindow.showDirectoryPicker = () => Promise.resolve(directory);
      const button = document.querySelector('[data-testid="open-folder"]');
      if (button instanceof HTMLButtonElement) button.click();
      return Promise.resolve();
    },
    setCamera,
    camera: cameraTelemetry.camera,
    cameraRange: cameraTelemetry.cameraRange,
    setSyntheticLoad,
  };
  window.__perf = bridge;
}
