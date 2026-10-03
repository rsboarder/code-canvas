import { z } from "zod";

const pointSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
});

const positiveMilliseconds = z.number().positive();

const panStepSchema = z.strictObject({
  kind: z.literal("pan"),
  x: z.number(),
  y: z.number(),
  dx: z.number(),
  dy: z.number(),
  durationMs: positiveMilliseconds,
});

const pinchStepSchema = z.strictObject({
  kind: z.literal("pinch"),
  scaleFactor: z.number().positive(),
  x: z.number(),
  y: z.number(),
  durationMs: positiveMilliseconds,
});

const scrollStepSchema = z.strictObject({
  kind: z.literal("scroll"),
  x: z.number(),
  y: z.number(),
  dy: z.number(),
  durationMs: positiveMilliseconds,
});

const dragStepSchema = z.strictObject({
  kind: z.literal("drag"),
  from: pointSchema,
  to: pointSchema,
  durationMs: positiveMilliseconds,
});

const resizeStepSchema = z.strictObject({
  kind: z.literal("resize"),
  from: pointSchema,
  to: pointSchema,
  durationMs: positiveMilliseconds,
});

const typeStepSchema = z.strictObject({
  kind: z.literal("type"),
  text: z.string(),
  charsPerSecond: positiveMilliseconds,
});

const pasteStepSchema = z.strictObject({
  kind: z.literal("paste"),
  text: z.string(),
});

const keyStepSchema = z.strictObject({
  kind: z.literal("key"),
  key: z.string(),
  code: z.string(),
  keyCode: z.number().int(),
  modifiers: z.number().int().nonnegative().optional(),
});

const waitStepSchema = z.strictObject({
  kind: z.literal("wait"),
  ms: z.number().nonnegative(),
});

const doubleClickStepSchema = z.strictObject({
  kind: z.literal("dblclick"),
  x: z.number(),
  y: z.number(),
});

export const scenarioStepSchema = z.discriminatedUnion("kind", [
  panStepSchema,
  pinchStepSchema,
  scrollStepSchema,
  dragStepSchema,
  resizeStepSchema,
  typeStepSchema,
  pasteStepSchema,
  keyStepSchema,
  waitStepSchema,
  doubleClickStepSchema,
]);

export const PERFORMANCE_SCENARIO_NAMES = [
  "Pan across the whole canvas at zoom 1.0",
  'Zoom from "Fit all" to 4.0 and back',
  "Worst-case text density",
  "Drag, resize and scroll inside a widget",
  "Typing",
  "Large edit in the editor",
  "Pan during initial load",
] as const;

const cameraSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  scale: z.number().positive(),
});

const setupSchema = z.strictObject({
  dataset: z.literal("reference"),
  camera: cameraSchema.optional(),
  approachScale: z.number().positive().optional(),
  scaleAtDevicePixelRatio: z.number().positive().optional(),
  requiresBridgeCommands: z.array(z.string()).optional(),
  editPath: z.string().min(1).optional(),
  initialLoad: z.literal(true).optional(),
});

export const scenarioSchema = z.strictObject({
  name: z.enum(PERFORMANCE_SCENARIO_NAMES),
  fast: z.boolean().optional(),
  setup: setupSchema,
  steps: z.array(scenarioStepSchema).min(1),
  durationMs: z.number().positive(),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioStep = z.infer<typeof scenarioStepSchema>;

export function isEditorOnlyScenario(scenario: Scenario): boolean {
  return (
    scenario.setup.editPath !== undefined &&
    scenario.steps.every(
      (step) =>
        step.kind === "type" ||
        step.kind === "paste" ||
        step.kind === "key" ||
        step.kind === "wait",
    )
  );
}
