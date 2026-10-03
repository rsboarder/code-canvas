import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Worst-case text density",
  fast: true,
  setup: {
    dataset: "reference",
    // 0.23 * 20 * 2 = 9.2 device px per line, just above the 9 px Text-hold
    // threshold; 0.3 * 20 * 2 = 12 px, above the 11 px switch-on threshold.
    camera: { x: -60, y: -920, scale: 0.23 },
    approachScale: 0.3,
    scaleAtDevicePixelRatio: 2,
    requiresBridgeCommands: ["setCamera"],
  },
  // x = -60, y = -920 keeps the view inside the grid: at DPR 2 the left/top
  // edges are 260/4000 board px; after the pan they are 4174/1826, and the
  // right edge is 11687 of the 11960 board px width for a 1728 px viewport.
  // The pan starts in a column gap: x = 671.4 maps to board x 1590 (mod 800
  // = 790) at DPR 1 and board x 3180 (mod 800 = 780) at DPR 2; y = 20.
  steps: [
    { kind: "pan", x: 671.4, y: 20, dx: 900, dy: -500, durationMs: 4_000 },
    { kind: "pinch", scaleFactor: 1.087, x: 600, y: 360, durationMs: 1_000 },
  ],
  durationMs: 5_000,
});
