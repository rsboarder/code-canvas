import { gzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chromium,
  type Browser,
  type Page,
  type CDPSession,
} from "@playwright/test";
import {
  Helpers,
  TraceModel,
} from "@paulirish/trace_engine/models/trace/trace.js";

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

interface TraceEvent {
  name?: string;
  cat?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  tid?: number;
  pid?: number;
  args?: Record<string, unknown>;
}

interface TraceFrames {
  engineFrameCount: number;
  presented: number;
  partiallyPresented: number;
  dropped: number;
  intervalsOver12_5Ms: number;
}

interface TraceDataPayload {
  value: TraceEvent[];
}

interface FrameReporter {
  state: string;
}

interface TraceCapture {
  events: TraceEvent[];
  listener: (payload: TraceDataPayload) => void;
}

interface GestureCapture {
  records: InputRecord[];
  inertiaTail: InputRecord[];
}

interface Attribution {
  applicationTaskCount: number;
  browserTaskCount: number;
  longestApplicationTaskMs: number | null;
  longestBrowserTaskMs: number | null;
  applicationEvidence: string[];
}

interface Measurement {
  durationSeconds: number;
  idleFrameStats: FrameStats;
  traceFrames: TraceFrames | null;
  traceEngine: string;
  input: {
    scroll: InputRecord[];
    pinch: InputRecord[];
    scrollInertiaTail: InputRecord[];
    pinchInertiaTail: InputRecord[];
  };
  attribution: Attribution | null;
  tracePaths: string[];
}

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const spikeRoot = join(root, "spikes", "a");
const resultsRoot = join(spikeRoot, "results");
const port = Number(process.env.SPIKE_PORT ?? 0);
const idleSeconds = Number(process.env.SPIKE_IDLE_SECONDS ?? 10);
const traceSeconds = Number(process.env.SPIKE_TRACE_SECONDS ?? 60);
const shouldTrace = process.env.SPIKE_SKIP_TRACE !== "1";

const json = (value: unknown): string => JSON.stringify(value, null, 2);
const progress = (message: string): void => {
  console.log(`[spike-a] ${message}`);
};

const startVite = async (): Promise<{ process: ChildProcess; url: string }> => {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  await listen(server, port);
  const address = server.address();
  const selectedPort =
    typeof address === "object" && address ? address.port : port;
  await closeServer(server);
  const vite = spawn(
    "pnpm",
    ["vite", "--host", "127.0.0.1", "--port", String(selectedPort)],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = `http://127.0.0.1:${String(selectedPort)}/spikes/a/`;
  await waitForVite(vite, url);
  return { process: vite, url };
};

const listen = (server: Server, requestedPort: number): Promise<void> =>
  new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, "127.0.0.1", () => {
      resolveListen();
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });

const waitForVite = async (vite: ChildProcess, url: string): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Vite is still starting.
    }
    if (vite.exitCode !== null) {
      throw new Error(
        `Vite exited before serving the spike: ${String(vite.exitCode)}`,
      );
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Vite at ${url}`);
};

const pageStats = async (page: Page): Promise<FrameStats> =>
  page.evaluate(() => window.__spikeA.getFrameStats());

const runIdleLog = async (page: Page): Promise<FrameStats> => {
  await page.evaluate(() => {
    window.__spikeA.resetFrameLog();
    window.__spikeA.startFrameLog();
  });
  await delay(idleSeconds * 1000);
  await page.evaluate(() => {
    window.__spikeA.stopFrameLog();
  });
  return pageStats(page);
};

const startTrace = async (client: CDPSession): Promise<TraceCapture> => {
  const events: TraceEvent[] = [];
  const listener = (payload: TraceDataPayload): void => {
    events.push(...payload.value);
  };
  client.on("Tracing.dataCollected", listener);
  await client.send("Tracing.start", {
    categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "toplevel",
      "blink.user_timing",
      "disabled-by-default-v8.gc",
      "input",
      "cc",
      "viz",
      "gpu",
    ].join(","),
    transferMode: "ReportEvents",
  });
  return { events, listener };
};

const stopTrace = async (
  client: CDPSession,
  capture: TraceCapture,
): Promise<TraceEvent[]> => {
  const complete = new Promise<void>((resolveComplete) => {
    client.once("Tracing.tracingComplete", () => {
      resolveComplete();
    });
  });
  await client.send("Tracing.end");
  await complete;
  client.off("Tracing.dataCollected", capture.listener);
  return capture.events;
};

const parseTraceFrames = async (
  events: TraceEvent[],
): Promise<TraceFrames | null> => {
  try {
    const model = TraceModel.Model.createWithAllHandlers();
    await model.parse(events as never[]);
    const parsed = model.parsedTrace();
    if (!parsed) {
      return null;
    }
    const pipelineEvents = events.filter(
      (event) => event.name === "PipelineReporter",
    );
    const pairedFrames = Helpers.Trace.createMatchedSortedSyntheticEvents(
      pipelineEvents as never[],
    );
    const frames = pairedFrames
      .map((frame) => {
        const source = (frame as { rawSourceEvent?: unknown }).rawSourceEvent;
        return isTraceEvent(source) ? source : null;
      })
      .filter((frame): frame is TraceEvent => frame !== null)
      .sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0));
    const presentedFrames = frames.filter(
      (frame) => frameReporter(frame)?.state === "STATE_PRESENTED_ALL",
    );
    let intervalsOver12_5Ms = 0;
    for (let index = 1; index < presentedFrames.length; index += 1) {
      const previous = presentedFrames[index - 1];
      const current = presentedFrames[index];
      if (
        previous &&
        current &&
        (current.ts ?? 0) - (previous.ts ?? 0) > 12_500
      ) {
        intervalsOver12_5Ms += 1;
      }
    }
    return {
      engineFrameCount: frames.length,
      presented: presentedFrames.length,
      partiallyPresented: frames.filter(
        (frame) => frameReporter(frame)?.state === "STATE_PRESENTED_PARTIAL",
      ).length,
      dropped: frames.filter(
        (frame) => frameReporter(frame)?.state === "STATE_DROPPED",
      ).length,
      intervalsOver12_5Ms,
    };
  } catch (error) {
    console.error(`trace_engine parse failed: ${String(error)}`);
    return null;
  }
};

const isTraceEvent = (value: unknown): value is TraceEvent =>
  typeof value === "object" && value !== null;

const frameReporter = (event: TraceEvent): FrameReporter | null => {
  const args = event.args;
  if (!args) {
    return null;
  }
  const candidate = args.frame_reporter ?? args.chrome_frame_reporter;
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const state = (candidate as { state?: unknown }).state;
  return typeof state === "string" ? { state } : null;
};

const stackText = (event: TraceEvent): string => json(event.args ?? {});

const isApplicationEvent = (event: TraceEvent, origin: string): boolean => {
  const details = stackText(event);
  return (
    details.includes(origin) ||
    details.includes("/spikes/a/") ||
    details.includes("main.ts")
  );
};

const attributeTasks = (events: TraceEvent[], origin: string): Attribution => {
  const tasks = events.filter((event) => {
    const name = event.name ?? "";
    return (
      name === "RunTask" ||
      name === "Task" ||
      name === "FunctionCall" ||
      name === "EvaluateScript"
    );
  });
  const application = tasks.filter((event) =>
    isApplicationEvent(event, origin),
  );
  const applicationSet = new Set(application);
  const hasApplicationChild = (event: TraceEvent): boolean =>
    (event.name === "RunTask" || event.name === "Task") &&
    application.some(
      (child) =>
        child.pid === event.pid &&
        child.tid === event.tid &&
        (child.ts ?? 0) >= (event.ts ?? 0) &&
        (child.ts ?? 0) + (child.dur ?? 0) <=
          (event.ts ?? 0) + (event.dur ?? 0) &&
        child !== event,
    );
  const browser = tasks.filter(
    (event) => !applicationSet.has(event) && !hasApplicationChild(event),
  );
  const longest = (items: TraceEvent[]): number | null => {
    const durations = items
      .map((event) => event.dur ?? 0)
      .filter((duration) => duration > 0);
    return durations.length ? Math.max(...durations) / 1000 : null;
  };
  return {
    applicationTaskCount: application.length,
    browserTaskCount: browser.length,
    longestApplicationTaskMs: longest(application),
    longestBrowserTaskMs: longest(browser),
    applicationEvidence: [
      "Main-thread task names: RunTask, Task, FunctionCall, EvaluateScript.",
      "Application attribution requires a stack or script URL containing the page origin or /spikes/a/.",
      "RunTask containers containing application children are excluded from browser totals to avoid double counting.",
      "v8.run and compositor/GPU tracks remain browser work unless their stack points to the application.",
    ],
  };
};

const synthesizeScroll = async (
  client: CDPSession,
  page: Page,
): Promise<GestureCapture> => {
  await page.evaluate(() => {
    window.__spikeA.clearInputRecords();
  });
  await client.send("Input.synthesizeScrollGesture", {
    x: 400,
    y: 300,
    xDistance: 0,
    yDistance: -600,
    speed: 800,
    gestureSourceType: "default",
    preventFling: false,
  });
  const completedAt = await page.evaluate(() => performance.now());
  await delay(1000);
  const records = await page.evaluate(() => window.__spikeA.getInputRecords());
  return {
    records,
    inertiaTail: records.filter((record) => record.timestamp > completedAt),
  };
};

const synthesizePinch = async (
  client: CDPSession,
  page: Page,
): Promise<GestureCapture> => {
  await page.evaluate(() => {
    window.__spikeA.clearInputRecords();
  });
  await client.send("Input.synthesizePinchGesture", {
    x: 400,
    y: 300,
    scaleFactor: 1.4,
    relativeSpeed: 800,
    gestureSourceType: "default",
  });
  const completedAt = await page.evaluate(() => performance.now());
  await delay(1000);
  const records = await page.evaluate(() => window.__spikeA.getInputRecords());
  return {
    records,
    inertiaTail: records.filter((record) => record.timestamp > completedAt),
  };
};

const saveTrace = async (
  events: TraceEvent[],
  label: string,
): Promise<string> => {
  await mkdir(resultsRoot, { recursive: true });
  const path = join(resultsRoot, `${label}.json.gz`);
  await writeFile(path, gzipSync(json({ traceEvents: events })));
  return path;
};

const run = async (): Promise<Measurement> => {
  progress("starting Vite");
  const vite = await startVite();
  progress(`serving ${vite.url}`);
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: false });
    progress("headed Chrome launched");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(vite.url, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      window.__spikeA.startInputRecorder();
    });
    const idleFrameStats = await runIdleLog(page);
    progress("idle rAF sample complete");
    const client = await context.newCDPSession(page);
    let traceFrames: TraceFrames | null = null;
    let attribution: Attribution | null = null;
    const tracePaths: string[] = [];
    if (shouldTrace) {
      progress(`recording ${String(traceSeconds)} s idle trace`);
      const noiseTrace = await startTrace(client);
      await page.evaluate(() => {
        window.__spikeA.resetFrameLog();
        window.__spikeA.startFrameLog();
      });
      await delay(traceSeconds * 1000);
      await page.evaluate(() => {
        window.__spikeA.stopFrameLog();
      });
      const noiseEvents = await stopTrace(client, noiseTrace);
      tracePaths.push(await saveTrace(noiseEvents, "idle-noise-floor"));
      traceFrames = await parseTraceFrames(noiseEvents);
      progress("idle trace parsed and saved");

      progress("recording attribution trace");
      const attributionTrace = await startTrace(client);
      await page.evaluate(() => {
        window.__spikeA.setBusyLoop(10);
      });
      await delay(Number(process.env.SPIKE_ATTRIBUTION_SECONDS ?? 10) * 1000);
      await page.evaluate(() => {
        window.__spikeA.setBusyLoop(0);
      });
      const attributionEvents = await stopTrace(client, attributionTrace);
      tracePaths.push(
        await saveTrace(attributionEvents, "attribution-busy-loop"),
      );
      attribution = attributeTasks(attributionEvents, vite.url);
      progress("attribution trace parsed and saved");
    }
    await page.evaluate(() => {
      window.__spikeA.startInputRecorder();
    });
    const scroll = await synthesizeScroll(client, page);
    progress("CDP scroll gesture complete");
    const pinch = await synthesizePinch(client, page);
    progress("CDP pinch gesture complete");
    return {
      durationSeconds: traceSeconds,
      idleFrameStats,
      traceFrames,
      traceEngine:
        "@paulirish/trace_engine TraceModel.Model.parse + Helpers.Trace.createMatchedSortedSyntheticEvents(PipelineReporter)",
      input: {
        scroll: scroll.records,
        pinch: pinch.records,
        scrollInertiaTail: scroll.inertiaTail,
        pinchInertiaTail: pinch.inertiaTail,
      },
      attribution,
      tracePaths,
    };
  } finally {
    await browser?.close();
    vite.process.kill();
  }
};

try {
  const measurement = await run();
  console.log(JSON.stringify(measurement));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
