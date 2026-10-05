import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Line break in the editor",
  fast: true,
  setup: {
    dataset: "reference",
    camera: { x: 40, y: 80, scale: 1 },
    editPath: "group-00/widget-000.tsx",
    requiresBridgeCommands: ["beginEditing"],
  },
  steps: [
    { kind: "wait", ms: 300 },
    { kind: "type", text: "\n", charsPerSecond: 10 },
    { kind: "wait", ms: 300 },
    { kind: "type", text: "\n", charsPerSecond: 10 },
    { kind: "wait", ms: 300 },
    { kind: "type", text: "\n", charsPerSecond: 10 },
    { kind: "wait", ms: 300 },
  ],
  durationMs: 1_500,
});
