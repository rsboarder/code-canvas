import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Pan during initial load",
  setup: { dataset: "reference" },
  steps: [
    { kind: "pan", x: 600, y: 400, dx: 1_200, dy: -600, durationMs: 5_000 },
  ],
  durationMs: 5_000,
});
