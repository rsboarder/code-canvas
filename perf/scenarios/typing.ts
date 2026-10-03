import { scenarioSchema } from "./schema";

export default scenarioSchema.parse({
  name: "Typing",
  fast: true,
  setup: {
    dataset: "reference",
    camera: { x: 40, y: 80, scale: 1 },
    editPath: "group-00/widget-000.tsx",
    requiresBridgeCommands: ["beginEditing"],
  },
  steps: [
    { kind: "type", text: "const typed = 1;\n", charsPerSecond: 10 },
    { kind: "wait", ms: 300 },
    { kind: "dblclick", x: 1000, y: 300 },
    { kind: "wait", ms: 600 },
    { kind: "dblclick", x: 400, y: 300 },
    { kind: "wait", ms: 600 },
  ],
  durationMs: 3_200,
});
