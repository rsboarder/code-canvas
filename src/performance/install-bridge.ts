import type { FrameStats } from "./frame-stats";
import { countLongIntervals, nearestRank } from "./frame-statistics";
import type { PerfBridge, PerfFile } from "./bridge";
import { createReferenceDirectory } from "./file-system-access-mock";

interface HarnessTelemetry {
  camera: PerfBridge["camera"];
  cameraRange: PerfBridge["cameraRange"];
  resetCameraRange(): void;
  settleState: PerfBridge["settleState"];
  beginEditing: PerfBridge["beginEditing"];
}

export function installPerfBridge(
  frameStats: FrameStats,
  setCamera: PerfBridge["setCamera"],
  telemetry: HarnessTelemetry,
  setSyntheticLoad: PerfBridge["setSyntheticLoad"],
): void {
  const bridge: PerfBridge = {
    snapshot: () => frameStats.snapshot(),
    settleState: telemetry.settleState,
    reset: () => {
      frameStats.reset();
      telemetry.resetCameraRange();
    },
    nearestRank,
    countLongIntervals,
    openFolder: async (files: readonly PerfFile[]) => {
      const directory = await createReferenceDirectory(files);
      const browserWindow = window as Window & {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
      };
      browserWindow.showDirectoryPicker = () => Promise.resolve(directory);
      const button = document.querySelector('[data-testid="open-folder"]');
      if (button instanceof HTMLButtonElement) button.click();
      await waitForWidgetCount(files.length);
    },
    setCamera,
    camera: telemetry.camera,
    cameraRange: telemetry.cameraRange,
    setSyntheticLoad,
    beginEditing: telemetry.beginEditing,
  };
  window.__perf = bridge;
}

function waitForWidgetCount(expected: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + 60_000;
    const check = (): void => {
      const canvas = document.querySelector('[data-testid="canvas"]');
      if (canvas?.getAttribute("data-widget-count") === String(expected)) {
        resolve();
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${String(expected)} widgets.`));
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}
