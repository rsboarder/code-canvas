import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: 'Zoom from "Fit all" to 4.0 and back',
  setup: {
    dataset: "reference",
    camera: { x: 0, y: 0, scale: 0.2 },
    requiresBridgeCommands: ["setCamera"],
  },
  steps: [
    { kind: "pinch", scaleFactor: 20, x: 600, y: 400, durationMs: 5_000 },
    { kind: "pinch", scaleFactor: 0.05, x: 600, y: 400, durationMs: 5_000 },
  ],
  durationMs: 10_000,
});
