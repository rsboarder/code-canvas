import { scenarioSchema } from "./schema";

const PASTED_TEXT = Array.from(
  { length: 500 },
  (_, index) => `const pasted${String(index)} = ${String(index)};\n`,
).join("");

export default scenarioSchema.parse({
  name: "Large edit in the editor",
  fast: false,
  setup: {
    dataset: "reference",
    camera: { x: 40, y: 80, scale: 1 },
    editPath: "group-00/widget-000.tsx",
    requiresBridgeCommands: ["beginEditing"],
  },
  steps: [
    { kind: "wait", ms: 300 },
    { kind: "paste", text: PASTED_TEXT },
    { kind: "wait", ms: 600 },
    {
      kind: "key",
      key: "z",
      code: "KeyZ",
      keyCode: 90,
      modifiers: 4,
    },
    { kind: "wait", ms: 600 },
  ],
  durationMs: 1_500,
});
