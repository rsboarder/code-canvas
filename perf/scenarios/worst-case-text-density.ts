import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Worst-case text density",
  fast: true,
  setup: {
    dataset: "reference",
    camera: { x: 0, y: 0, scale: 1 },
    requiresBridgeCommands: ["setCamera"],
  },
  steps: [
    { kind: "pan", x: 600, y: 400, dx: 900, dy: -500, durationMs: 5_000 },
  ],
  durationMs: 5_000,
});
