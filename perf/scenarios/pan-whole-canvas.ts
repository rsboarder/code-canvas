import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Pan across the whole canvas at zoom 1.0",
  fast: true,
  setup: {
    dataset: "reference",
    camera: { x: 0, y: 0, scale: 1 },
    requiresBridgeCommands: ["setCamera"],
  },
  steps: [
    { kind: "pan", x: 600, y: 20, dx: 1_800, dy: -900, durationMs: 5_000 },
  ],
  durationMs: 5_000,
});
