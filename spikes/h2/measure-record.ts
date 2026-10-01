import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CDPSession } from "@playwright/test";
import { decodePng } from "../h/png";
import {
  alignmentReport,
  createTextMask,
  type TextMask,
} from "./measure-capture";
import {
  closePage,
  preparePage,
  RENDERERS,
  RESULT_DIR,
  runEventsWithCap,
  scenarioEntry,
  setupCamera,
  wait,
  withBrowser,
  CELL_TIMEOUT_MS,
  type Renderer,
} from "./measure-shared";

export async function recordRenderer(
  renderer: string,
  scenarioKey: string,
): Promise<void> {
  const selected = renderer as Renderer;
  if (!RENDERERS.includes(selected))
    throw new Error(`unknown renderer ${renderer}`);
  const entry = scenarioEntry(scenarioKey);
  const directory = resolve(RESULT_DIR, `record-${renderer}-${scenarioKey}`);
  await mkdir(directory, { recursive: true });
  await withBrowser(async (context, url) => {
    const page = await preparePage(context, url, selected);
    let cdp: CDPSession | undefined;
    let sampler: Promise<void> | undefined;
    let screencastStarted = false;
    const samples: unknown[] = [];
    const frames: { index: number; time: number; textPixels: number }[] = [];
    const recent: { index: number; mask: TextMask }[] = [];
    const pending: Promise<void>[] = [];
    let before: { index: number; mask: TextMask } | undefined;
    let after: { index: number; mask: TextMask } | undefined;
    let observedSwitches = 0;
    let index = 0;
    try {
      await setupCamera(page, entry.camera);
      await wait(500);
      const session = await context.newCDPSession(page);
      cdp = session;
      cdp.on(
        "Page.screencastFrame",
        (frame: {
          data: string;
          sessionId: number;
          metadata: { timestamp?: number };
        }) => {
          const current = index++;
          const bytes = Buffer.from(frame.data, "base64");
          const mask = createTextMask(decodePng(bytes));
          const captured = { index: current, mask };
          recent.push(captured);
          if (recent.length > 12) recent.shift();
          if (before && !after) after = captured;
          frames.push({
            index: current,
            time: frame.metadata.timestamp ?? 0,
            textPixels: mask.count,
          });
          pending.push(
            writeFile(
              resolve(
                directory,
                `frame-${String(current).padStart(4, "0")}.png`,
              ),
              bytes,
            ),
          );
          void session
            .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
            .catch(() => undefined);
        },
      );
      const deadline = Date.now() + entry.scenario.durationMs + 1_000;
      sampler = (async () => {
        while (Date.now() < deadline) {
          const metrics = await page.evaluate(() =>
            window.__spikeH2?.getMetrics(),
          );
          const switches =
            typeof metrics?.atlasSizeSwitches === "number"
              ? metrics.atlasSizeSwitches
              : 0;
          if (selected === "atlas" && switches > observedSwitches && !before) {
            const candidate =
              recent[recent.length - 2] ?? recent[recent.length - 1];
            if (candidate) {
              before = candidate;
              observedSwitches = switches;
            }
          }
          samples.push({ t: Date.now(), m: metrics });
          await wait(50);
        }
      })();
      await cdp.send("Page.startScreencast", {
        format: "png",
        everyNthFrame: 1,
        maxWidth: 1200,
        maxHeight: 720,
      });
      screencastStarted = true;
      await runEventsWithCap(cdp, entry.scenario, CELL_TIMEOUT_MS);
      await page.evaluate(() => window.__spikeH2?.endGesture());
      await wait(300);
    } finally {
      if (screencastStarted && cdp)
        await cdp.send("Page.stopScreencast").catch(() => undefined);
      if (sampler)
        await Promise.race([sampler, wait(1_000)]).catch(() => undefined);
      await Promise.all(pending).catch(() => undefined);
      const sorted = frames
        .slice()
        .sort((left, right) => left.index - right.index);
      const median =
        sorted
          .map((frame) => frame.textPixels)
          .sort((left, right) => left - right)[Math.floor(sorted.length / 2)] ??
        0;
      const alignment =
        before && after ? alignmentReport(before, after) : "not measured";
      await writeFile(
        resolve(directory, "frames.json"),
        JSON.stringify({ median, alignment, frames: sorted, samples }, null, 2),
      );
      console.log(
        `PAGE: record ${renderer}/${scenarioKey}: ${String(sorted.length)} frames, alignment ${JSON.stringify(alignment)}`,
      );
      if (alignment !== "not measured" && alignment.distance > 0.5)
        console.error(
          `SANITY CHECK FAILED: atlas switch text shifted ${String(alignment.distance)} device px`,
        );
      await closePage(page);
    }
  });
}
