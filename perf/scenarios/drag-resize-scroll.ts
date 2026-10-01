import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Drag, resize and scroll inside a widget",
  fast: true,
  setup: {
    dataset: "reference",
    camera: { x: 0, y: 0, scale: 1 },
    requiresBridgeCommands: ["setCamera"],
  },
  steps: [
    {
      kind: "drag",
      from: { x: 300, y: 240 },
      to: { x: 620, y: 420 },
      durationMs: 2_000,
    },
    {
      kind: "resize",
      from: { x: 620, y: 420 },
      to: { x: 760, y: 520 },
      durationMs: 2_000,
    },
    { kind: "scroll", x: 500, y: 350, dy: 1_000, durationMs: 2_000 },
  ],
  durationMs: 6_000,
});
