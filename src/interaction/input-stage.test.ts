import { describe, expect, it, vi } from "vitest";

import { BoardService, type BoardMetrics } from "../board";
import { createEventBus } from "../shared/events";
import type { GesturePhase } from "../shared/frame";
import { PINCH_WHEEL_DELTA_PER_LN_SCALE } from "../shared/pinch";
import type { WorkspaceEvent } from "../workspace";
import { createInputStage, type InputStage } from "./input-stage";
import type { WheelInput } from "./gesture-targeting";
import { GestureTargeting } from "./gesture-targeting";

const metrics: BoardMetrics = {
  baseLineHeight: 20,
  headerHeight: 42,
  minimumWidth: 240,
  minimumBodyLines: 3,
  columnWidth: 760,
  gridGap: 40,
  maximumHeight: 900,
  edgeGrabScreenPx: 8,
};

interface Environment {
  readonly board: BoardService;
  readonly targeting: GestureTargeting;
  readonly editing: {
    readonly isEditing: boolean;
    readonly isExitHeld: boolean;
  };
  readonly releaseEditing: () => void;
  readonly frameGestureValues: boolean[];
  readonly phases: GesturePhase[];
  readonly detail: { update(devicePixelRatio: number): void };
  readonly stage: InputStage;
}

function createEnvironment(): Environment {
  const board = new BoardService(metrics, createEventBus<WorkspaceEvent>());
  const editingState = {
    activeWidgetId: "file.ts" as string | undefined,
    isEditing: true,
    isExitHeld: false,
  };
  const editing = {
    get isEditing() {
      return editingState.isEditing;
    },
    get isExitHeld() {
      return editingState.isExitHeld;
    },
    end: vi.fn(() => {
      editingState.isExitHeld = true;
      return true;
    }),
    begin: vi.fn(() => true),
  };
  const targeting = new GestureTargeting(board, editingState);
  const frameGestureValues: boolean[] = [];
  const phases: GesturePhase[] = [];
  const detail = {
    update: (): void => undefined,
  };
  const stage = createInputStage({
    board,
    targeting,
    getEditing: () => editing,
    frame: {
      setGestureInProgress: (value) => frameGestureValues.push(value),
      invalidate: vi.fn(),
    },
    phase: {
      setGesturePhase: (phase) => phases.push(phase),
    },
    detail,
    viewportWidth: () => 1200,
    viewportHeight: () => 800,
    updateWidgetBodyRect: vi.fn(),
    toggleMetricsOverlay: vi.fn(),
  });
  return {
    board,
    targeting,
    editing,
    releaseEditing: () => {
      editingState.activeWidgetId = undefined;
      editingState.isEditing = false;
      editingState.isExitHeld = false;
    },
    frameGestureValues,
    phases,
    detail,
    stage,
  };
}

function wheel(overrides: Partial<WheelInput> = {}): WheelInput {
  return {
    deltaX: 0,
    deltaY: 0,
    ctrlKey: false,
    metaKey: false,
    offsetX: 10,
    offsetY: 20,
    timeStamp: 0,
    preventDefault: () => undefined,
    ...overrides,
  };
}

function apply(environment: Environment): void {
  environment.stage.apply(0, 1);
}

describe("InputStage exit replay", () => {
  it("Pan during editing", () => {
    const environment = createEnvironment();
    const pan = vi.spyOn(environment.board, "pan");
    environment.targeting.wheel(wheel({ deltaY: 4 }));

    apply(environment);
    expect(pan).not.toHaveBeenCalled();

    environment.releaseEditing();
    apply(environment);
    expect(pan).toHaveBeenCalledOnce();
    expect(pan).toHaveBeenCalledWith(0, -4);
  });

  it("Zoom during editing", () => {
    const environment = createEnvironment();
    const zoomAt = vi.spyOn(environment.board, "zoomAt");
    environment.targeting.wheel(
      wheel({ ctrlKey: true, deltaY: -4, offsetX: 90, offsetY: 120 }),
    );

    apply(environment);
    expect(zoomAt).not.toHaveBeenCalled();

    environment.releaseEditing();
    apply(environment);
    expect(zoomAt).toHaveBeenCalledOnce();
    expect(zoomAt).toHaveBeenCalledWith(
      90,
      120,
      expect.closeTo(Math.exp(4 / PINCH_WHEEL_DELTA_PER_LN_SCALE), 9),
    );
  });

  it("Fit all while editing", () => {
    const environment = createEnvironment();
    const fitAll = vi.spyOn(environment.board, "fitAll");
    environment.targeting.requestFitAll();

    apply(environment);
    environment.releaseEditing();
    apply(environment);

    expect(fitAll).toHaveBeenCalledOnce();
    expect(fitAll).toHaveBeenCalledWith(1200, 800);
  });

  it("held exit accumulates and replays", () => {
    const environment = createEnvironment();
    const pan = vi.spyOn(environment.board, "pan");
    environment.targeting.wheel(wheel({ deltaY: 4 }));
    apply(environment);

    environment.targeting.wheel(wheel({ deltaY: 5, timeStamp: 10 }));
    apply(environment);
    expect(pan).not.toHaveBeenCalled();

    environment.releaseEditing();
    apply(environment);
    expect(pan).toHaveBeenCalledOnce();
    expect(pan).toHaveBeenCalledWith(0, -9);
  });
});

describe("InputStage frame state", () => {
  it("updates Detail Level before publishing the gesture phase", () => {
    const environment = createEnvironment();
    let detailLevelAtPhase = "text";
    environment.detail.update = (devicePixelRatio) => {
      environment.board.updateDetailLevel(devicePixelRatio, true);
      detailLevelAtPhase = environment.board.detailLevel;
    };

    environment.stage.apply(0, 0.1);

    expect(detailLevelAtPhase).toBe("minimap");
    expect(environment.phases[0]?.detailIsMinimap).toBe(true);
  });

  it("keeps the FrameLoop alive for held and active gestures", () => {
    const environment = createEnvironment();
    const takeIntents = vi.spyOn(environment.targeting, "takeIntents");
    environment.targeting.wheel(wheel({ deltaY: 4 }));

    apply(environment);
    expect(takeIntents).not.toHaveBeenCalled();
    expect(environment.frameGestureValues).toEqual([true]);

    environment.releaseEditing();
    apply(environment);
    expect(environment.frameGestureValues[1]).toBe(true);
  });

  it("reuses the published gesture phase", () => {
    const environment = createEnvironment();

    environment.stage.apply(0, 1);
    environment.stage.apply(1, 1);

    expect(environment.phases[1]).toBe(environment.phases[0]);
  });
});
