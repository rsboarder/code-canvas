import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Typing",
  fast: true,
  setup: { dataset: "reference", requiresBridgeCommands: ["beginEditing"] },
  steps: [
    { kind: "type", text: "const typedValue = true;\n", charsPerSecond: 10 },
  ],
  durationMs: 2_400,
});
