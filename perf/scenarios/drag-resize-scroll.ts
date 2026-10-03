import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Drag, resize and scroll inside a widget",
  fast: true,
  setup: {
    dataset: "reference",
    camera: { x: 0, y: 80, scale: 1 },
    requiresBridgeCommands: ["setCamera"],
  },
  steps: [
    // The drag and resize each return to their starting positions.
    {
      kind: "drag",
      from: { x: 300, y: 101 },
      to: { x: 620, y: 281 },
      durationMs: 1_000,
    },
    {
      kind: "drag",
      from: { x: 620, y: 281 },
      to: { x: 300, y: 101 },
      durationMs: 1_000,
    },
    {
      kind: "resize",
      from: { x: 764, y: 480 },
      to: { x: 904, y: 480 },
      durationMs: 1_000,
    },
    {
      kind: "resize",
      from: { x: 904, y: 480 },
      to: { x: 764, y: 480 },
      durationMs: 1_000,
    },
    // Maximum modeled fling speed: 24,000 CSS px/s; return to repeat the same range.
    { kind: "scroll", x: 500, y: 430, dy: 24_000, durationMs: 1_000 },
    { kind: "scroll", x: 500, y: 430, dy: -24_000, durationMs: 1_000 },
  ],
  durationMs: 6_000,
});
