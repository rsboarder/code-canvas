import type { FrameStage } from "../shared/frame";

export interface FrameStageSteps {
  readonly applyInput: () => boolean;
  readonly restoreWorkspaceLayout: () => boolean;
  readonly syncWidgetTable: () => boolean;
  readonly cull: () => boolean;
  readonly reportRasterError: () => boolean;
  readonly applyEditingSwap: () => boolean;
  readonly drain: () => boolean;
  readonly draw: () => boolean;
  readonly frameLog?: () => boolean;
}

export function createFrameStages(steps: FrameStageSteps): FrameStage[] {
  const stages: FrameStage[] = [
    { name: "apply-input", run: steps.applyInput },
    {
      name: "restore-workspace-layout",
      run: steps.restoreWorkspaceLayout,
    },
    { name: "widget-table", run: steps.syncWidgetTable },
    { name: "cull", run: steps.cull },
    { name: "report-raster-error", run: steps.reportRasterError },
    { name: "editing-swap", run: steps.applyEditingSwap },
    { name: "residency-drain", run: steps.drain },
    { name: "draw", run: steps.draw },
  ];
  if (steps.frameLog) stages.push({ name: "frame-log", run: steps.frameLog });
  return stages;
}
