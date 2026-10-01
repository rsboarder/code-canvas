import type { FrameStats } from "./frame-stats";
import { countLongIntervals, nearestRank } from "./frame-statistics";
import type { PerfBridge, PerfFile } from "./bridge";
import { createInMemoryDirectory } from "./file-system-access-mock";

export function installPerfBridge(
  frameStats: FrameStats,
  setCamera: PerfBridge["setCamera"],
  setSyntheticLoad: PerfBridge["setSyntheticLoad"],
): void {
  const bridge: PerfBridge = {
    snapshot: () => frameStats.snapshot(),
    reset: () => {
      frameStats.reset();
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
    setSyntheticLoad,
  };
  window.__perf = bridge;
}
