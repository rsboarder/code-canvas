import { describe, expect, it } from "vitest";

import { createFrameStages, type FrameStageSteps } from "./frame-stages";

const stageNames = [
  "apply-input",
  "restore-workspace-layout",
  "widget-table",
  "cull",
  "report-raster-error",
  "editing-swap",
  "residency-drain",
  "draw",
] as const;

function recordingSteps(recorded: string[]): FrameStageSteps {
  return {
    applyInput: () => {
      recorded.push("apply-input");
      return false;
    },
    restoreWorkspaceLayout: () => {
      recorded.push("restore-workspace-layout");
      return false;
    },
    syncWidgetTable: () => {
      recorded.push("widget-table");
      return false;
    },
    cull: () => {
      recorded.push("cull");
      return false;
    },
    reportRasterError: () => {
      recorded.push("report-raster-error");
      return false;
    },
    applyEditingSwap: () => {
      recorded.push("editing-swap");
      return false;
    },
    drain: () => {
      recorded.push("residency-drain");
      return false;
    },
    draw: () => {
      recorded.push("draw");
      return false;
    },
  };
}

describe("createFrameStages", () => {
  it("runs stages in the D8 order and includes the frame log last when provided", () => {
    const recorded: string[] = [];
    const stages = createFrameStages({
      ...recordingSteps(recorded),
      frameLog: () => {
        recorded.push("frame-log");
        return false;
      },
    });

    for (const stage of stages) stage.run();

    expect(stages.map(({ name }) => name)).toEqual([
      ...stageNames,
      "frame-log",
    ]);
    expect(recorded).toEqual([...stageNames, "frame-log"]);
  });

  it("omits frame log when it is not provided", () => {
    const recorded: string[] = [];
    const stages = createFrameStages(recordingSteps(recorded));

    for (const stage of stages) stage.run();

    expect(stages.map(({ name }) => name)).toEqual(stageNames);
    expect(recorded).toEqual(stageNames);
  });

  it("keeps the D8 stage dependencies in order", () => {
    const stagePositions = createFrameStages({
      ...recordingSteps([]),
      frameLog: () => false,
    }).map(({ name }) => name);

    expect(stagePositions.indexOf("apply-input")).toBe(0);
    expect(stagePositions.indexOf("widget-table")).toBeLessThan(
      stagePositions.indexOf("cull"),
    );
    expect(stagePositions.indexOf("cull")).toBeLessThan(
      stagePositions.indexOf("residency-drain"),
    );
    expect(stagePositions.indexOf("residency-drain")).toBeLessThan(
      stagePositions.indexOf("draw"),
    );
    expect(stagePositions.indexOf("editing-swap")).toBeLessThan(
      stagePositions.indexOf("residency-drain"),
    );
    expect(stagePositions.indexOf("report-raster-error")).toBeLessThan(
      stagePositions.indexOf("residency-drain"),
    );
    expect(stagePositions.indexOf("frame-log")).toBeGreaterThan(
      stagePositions.indexOf("draw"),
    );
  });
});
