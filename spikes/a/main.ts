interface InputRecord {
  type: string;
  timestamp: number;
  ctrlKey: boolean;
  deltaMode?: number;
  deltaX?: number;
  deltaY?: number;
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  pointerType?: string;
  buttons?: number;
}

interface FrameStats {
  running: boolean;
  sampleCount: number;
  estimatedRefreshRate: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  longIntervalsPerMinute: number;
}

interface SpikeApi {
  startFrameLog: () => void;
  stopFrameLog: () => void;
  resetFrameLog: () => void;
  getFrameStats: () => FrameStats;
  startInputRecorder: () => void;
  stopInputRecorder: () => void;
  clearInputRecords: () => void;
  getInputRecords: () => InputRecord[];
  setBusyLoop: (durationMs: number) => void;
}

const RING_SIZE = 4096;
const LONG_INTERVAL_MS = 12.5;
const intervalRing = new Float64Array(RING_SIZE);
const timestampRing = new Float64Array(RING_SIZE);
const inputRecords: InputRecord[] = [];
let ringCursor = 0;
let ringCount = 0;
let previousFrameTime: number | null = null;
let frameLogRunning = false;
let inputRecording = false;
let busyDurationMs = 0;
let busyTimer: number | null = null;

const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
};

const output = (id: string, value: string): void => {
  byId(id).textContent = value;
};

const percentile = (values: number[], quantile: number): number | null => {
  if (values.length === 0) {
    return null;
  }
  const index = Math.min(
    values.length - 1,
    Math.floor((values.length - 1) * quantile),
  );
  return values[index] ?? null;
};

const getRecentIntervals = (now: number): number[] => {
  const intervals: number[] = [];
  const first = Math.max(0, ringCount - RING_SIZE);
  for (let offset = first; offset < ringCount; offset += 1) {
    const index = (ringCursor - ringCount + offset + RING_SIZE) % RING_SIZE;
    const timestamp = timestampRing[index] ?? 0;
    if (timestamp >= now - 60_000) {
      const interval = intervalRing[index];
      if (interval !== undefined) {
        intervals.push(interval);
      }
    }
  }
  return intervals;
};

const calculateFrameStats = (): FrameStats => {
  const now = performance.now();
  const intervals = getRecentIntervals(now).sort((left, right) => left - right);
  const p50 = percentile(intervals, 0.5);
  const p95 = percentile(intervals, 0.95);
  const p99 = percentile(intervals, 0.99);
  return {
    running: frameLogRunning,
    sampleCount: ringCount,
    estimatedRefreshRate: p50 === null || p50 === 0 ? null : 1000 / p50,
    p50,
    p95,
    p99,
    longIntervalsPerMinute: intervals.filter(
      (interval) => interval > LONG_INTERVAL_MS,
    ).length,
  };
};

const formatMetric = (value: number | null, suffix = " ms"): string =>
  value === null ? "n/a" : `${value.toFixed(3)}${suffix}`;

const renderStats = (): void => {
  const stats = calculateFrameStats();
  output("frame-state", stats.running ? "running" : "stopped");
  output("sample-count", String(stats.sampleCount));
  output("refresh-rate", formatMetric(stats.estimatedRefreshRate, " Hz"));
  output("p50", formatMetric(stats.p50));
  output("p95", formatMetric(stats.p95));
  output("p99", formatMetric(stats.p99));
  output("long-intervals", String(stats.longIntervalsPerMinute));
  output("event-count", String(inputRecords.length));
  const recent = inputRecords.slice(-8);
  byId("event-preview").textContent = recent.length
    ? JSON.stringify(recent, null, 2)
    : "No input events recorded.";
};

const frame = (timestamp: number): void => {
  if (previousFrameTime !== null) {
    const ringIndex = ringCursor % RING_SIZE;
    intervalRing[ringIndex] = timestamp - previousFrameTime;
    timestampRing[ringIndex] = timestamp;
    ringCursor = (ringCursor + 1) % RING_SIZE;
    ringCount = Math.min(RING_SIZE, ringCount + 1);
  }
  previousFrameTime = timestamp;
  if (frameLogRunning) {
    requestAnimationFrame(frame);
  }
};

const startFrameLog = (): void => {
  if (frameLogRunning) {
    return;
  }
  frameLogRunning = true;
  previousFrameTime = null;
  requestAnimationFrame(frame);
};

const stopFrameLog = (): void => {
  frameLogRunning = false;
};

const resetFrameLog = (): void => {
  stopFrameLog();
  intervalRing.fill(0);
  timestampRing.fill(0);
  ringCursor = 0;
  ringCount = 0;
  previousFrameTime = null;
  renderStats();
};

const recordInput = (event: Event): void => {
  if (!inputRecording) {
    return;
  }
  const candidate = event as WheelEvent & PointerEvent;
  const record: InputRecord = {
    type: event.type,
    timestamp: performance.now(),
    ctrlKey: "ctrlKey" in candidate ? candidate.ctrlKey : false,
  };
  if (event instanceof WheelEvent) {
    record.deltaMode = event.deltaMode;
    record.deltaX = event.deltaX;
    record.deltaY = event.deltaY;
    record.clientX = event.clientX;
    record.clientY = event.clientY;
  }
  if (event instanceof PointerEvent) {
    record.pointerId = event.pointerId;
    record.pointerType = event.pointerType;
    record.buttons = event.buttons;
    record.clientX = event.clientX;
    record.clientY = event.clientY;
  }
  inputRecords.push(record);
  output("event-count", String(inputRecords.length));
};

const setBusyLoop = (durationMs: number): void => {
  busyDurationMs = durationMs;
  if (busyTimer !== null) {
    window.clearInterval(busyTimer);
    busyTimer = null;
  }
  if (durationMs > 0) {
    busyTimer = window.setInterval(() => {
      const end = performance.now() + busyDurationMs;
      while (performance.now() < end) {
        // Intentional load for the attribution demonstration.
      }
    }, 1000);
  }
};

const toggleFrameButton = byId("toggle-frame-log") as HTMLButtonElement;
toggleFrameButton.addEventListener("click", () => {
  if (frameLogRunning) {
    stopFrameLog();
    toggleFrameButton.textContent = "Start frame log";
  } else {
    startFrameLog();
    toggleFrameButton.textContent = "Stop frame log";
  }
  renderStats();
});
byId("reset-frame-log").addEventListener("click", resetFrameLog);
const inputButton = byId("toggle-input-recorder") as HTMLButtonElement;
inputButton.addEventListener("click", () => {
  inputRecording = !inputRecording;
  inputButton.textContent = inputRecording
    ? "Stop input recorder"
    : "Start input recorder";
  byId("status").textContent = inputRecording
    ? "Recording DOM input events."
    : "Input recorder stopped.";
});
byId("copy-input").addEventListener("click", () => {
  void copyInputResults();
});
const copyInputResults = async (): Promise<void> => {
  const payload = JSON.stringify(
    { recordedAt: new Date().toISOString(), events: inputRecords },
    null,
    2,
  );
  try {
    await navigator.clipboard.writeText(payload);
    byId("status").textContent = "Input results copied as JSON.";
  } catch {
    byId("status").textContent =
      "Clipboard unavailable; use the recorded events shown in the page API.";
  }
};
byId("fullscreen").addEventListener("click", () => {
  void toggleFullscreen();
});
const toggleFullscreen = async (): Promise<void> => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    byId("status").textContent = "Exited fullscreen.";
    return;
  }
  await document.documentElement.requestFullscreen();
  byId("status").textContent =
    "Fullscreen requested; record the before/after condition.";
};
const busyButton = byId("toggle-busy") as HTMLButtonElement;
busyButton.addEventListener("click", () => {
  const nextDuration = busyDurationMs > 0 ? 0 : 10;
  setBusyLoop(nextDuration);
  busyButton.textContent =
    nextDuration > 0 ? "Busy loop: 10 ms / second" : "Busy loop: off";
});

for (const type of [
  "wheel",
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "gesturestart",
  "gesturechange",
  "gestureend",
]) {
  window.addEventListener(type, recordInput, { passive: true });
}

window.setInterval(renderStats, 250);
renderStats();

const api: SpikeApi = {
  startFrameLog,
  stopFrameLog,
  resetFrameLog,
  getFrameStats: calculateFrameStats,
  startInputRecorder: () => {
    inputRecording = true;
  },
  stopInputRecorder: () => {
    inputRecording = false;
  },
  clearInputRecords: () => {
    inputRecords.length = 0;
    renderStats();
  },
  getInputRecords: () => inputRecords.map((record) => ({ ...record })),
  setBusyLoop,
};

declare global {
  interface Window {
    __spikeA: SpikeApi;
  }
}

window.__spikeA = api;
