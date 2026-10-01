interface SyntheticLoad {
  readonly cpuMs: number;
  readonly gpuIterations: number;
}

interface SyntheticLoadStage {
  readonly name: "synthetic-load";
  setLoad(load: SyntheticLoad): void;
  run(): void;
}

export function createSyntheticLoadStage(
  drawGpu: (iterations: number) => void,
  invalidate: () => void,
): SyntheticLoadStage {
  let load: SyntheticLoad = { cpuMs: 0, gpuIterations: 0 };
  return {
    name: "synthetic-load",
    setLoad: (nextLoad) => {
      load = {
        cpuMs: Math.max(0, nextLoad.cpuMs),
        gpuIterations: Math.max(0, Math.floor(nextLoad.gpuIterations)),
      };
      if (isActive(load)) invalidate();
    },
    run: () => {
      busyWait(load.cpuMs);
      if (load.gpuIterations > 0) drawGpu(load.gpuIterations);
      if (isActive(load)) invalidate();
    },
  };
}

function busyWait(durationMs: number): void {
  if (durationMs <= 0) return;
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    // Deliberately consume the main thread for the requested duration.
  }
}

function isActive(load: SyntheticLoad): boolean {
  return load.cpuMs > 0 || load.gpuIterations > 0;
}
