import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Pan during initial load",
  setup: {
    dataset: "reference",
    camera: { x: 0, y: 0, scale: 1 },
    requiresBridgeCommands: ["setCamera"],
  },
  steps: [
    { kind: "pan", x: 600, y: 400, dx: 1_200, dy: -600, durationMs: 5_000 },
  ],
  durationMs: 5_000,
});
