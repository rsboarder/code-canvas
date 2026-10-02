import { describe, expect, it } from "vitest";

import {
  TileSetPlanner,
  coarseRasterScale,
  viewBoundsAtZoom,
} from "./tile-sets";
import { computeTilePoolCapacity } from "./tile-plan";

function records(capacity = 32) {
  return {
    active: new Uint8Array(capacity),
    ready: new Uint8Array(capacity),
    kind: new Uint8Array(capacity),
    rasterScale: new Float64Array(capacity),
    epoch: new Int32Array(capacity),
    contentVersion: new Int32Array(capacity),
    column: new Int32Array(capacity),
    row: new Int32Array(capacity),
    localX: new Float64Array(capacity),
    localY: new Float64Array(capacity),
    width: new Float64Array(capacity),
    height: new Float64Array(capacity),
  };
}

function plannerWith(scale: number, epoch: number, column = 0, row = 0) {
  const view = records();
  view.active[0] = 1;
  view.ready[0] = 1;
  view.rasterScale[0] = scale;
  view.epoch[0] = epoch;
  view.column[0] = column;
  view.row[0] = row;
  view.localX[0] = column * (512 / scale);
  view.localY[0] = row * (512 / scale);
  view.width[0] = 512 / scale;
  view.height[0] = 512 / scale;
  return { view, planner: new TileSetPlanner(view, 32) };
}

const COMMON = {
  contentWidth: 1024,
  contentHeight: 1024,
  visibleLeft: 0,
  visibleTop: 0,
  visibleRight: 512,
  visibleBottom: 512,
  zoom: 1,
  devicePixelRatio: 1,
  epoch: 1,
  recordCount: 0,
};

interface PlannerInput {
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly visibleLeft: number;
  readonly visibleTop: number;
  readonly visibleRight: number;
  readonly visibleBottom: number;
  readonly zoom: number;
  readonly devicePixelRatio: number;
  readonly gestureActive: boolean;
  readonly epoch: number;
  readonly recordCount: number;
}

function buildPlanner(planner: TileSetPlanner, input: PlannerInput): void {
  planner.setContentSize(input.contentWidth, input.contentHeight);
  planner.setVisibleBounds(
    input.visibleLeft,
    input.visibleTop,
    input.visibleRight,
    input.visibleBottom,
  );
  planner.setZoom(input.zoom, input.devicePixelRatio, input.gestureActive);
  planner.setEpoch(input.epoch);
  planner.build(input.recordCount);
}

describe("TileSetPlanner", () => {
  it("requests visible tiles and a margin ring at rest", () => {
    const { planner } = plannerWith(1, 2);
    buildPlanner(planner, { ...COMMON, gestureActive: false });
    expect(planner.requestCount).toBe(4);
    expect(planner.drawCurrentCount).toBe(0);
    expect(planner.missingTile).toBe(true);
  });

  it("does not request a zoom-in area already covered by a resident tile", () => {
    const scale = coarseRasterScale(1.7, 1);
    const { view, planner } = plannerWith(scale, 1);
    buildPlanner(planner, {
      contentWidth: 1024,
      contentHeight: 1024,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 1.7,
      devicePixelRatio: 1,
      gestureActive: true,
      epoch: 1,
      recordCount: 1,
    });
    expect(planner.requestCount).toBe(0);
    expect(planner.missingTile).toBe(false);
    expect(view.rasterScale[0]).toBe(scale);
  });

  it("uses the camera scale times device pixel ratio at rest", () => {
    const { planner } = plannerWith(2.74, 1);
    buildPlanner(planner, {
      ...COMMON,
      zoom: 1.37,
      devicePixelRatio: 2,
      gestureActive: false,
      recordCount: 0,
    });

    expect(planner.requestedScale).toBeCloseTo(2.74);
  });

  it("clips coverage to a short content edge before sampling", () => {
    const view = records();
    view.active[0] = 1;
    view.ready[0] = 1;
    view.rasterScale[0] = 1;
    view.epoch[0] = 1;
    view.width[0] = 512;
    view.height[0] = 100;
    const planner = new TileSetPlanner(view, 32);

    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 100,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 100,
      zoom: 1,
      devicePixelRatio: 1,
      gestureActive: true,
      epoch: 1,
      recordCount: 1,
    });

    expect(planner.requestCount).toBe(0);
    expect(planner.missingTile).toBe(false);
    expect(planner.textReady()).toBe(true);
  });
});

describe("TileSetPlanner label draw set", () => {
  it("keeps a resident label tile when the content epoch changes", () => {
    const view = records(4);
    view.active[0] = 1;
    view.ready[0] = 1;
    view.kind[0] = 1;
    view.rasterScale[0] = 1;
    view.epoch[0] = 1;
    view.column[0] = 0;
    view.row[0] = 0;
    view.width[0] = 512;
    view.height[0] = 42;
    const planner = new TileSetPlanner(view, 4);
    planner.setHeaderHeight(42);
    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 1,
      devicePixelRatio: 1,
      gestureActive: false,
      epoch: 2,
      recordCount: 1,
    });

    expect(planner.requestHeaderCount).toBe(1);
    expect(planner.drawHeaderCurrentCount).toBe(1);
    expect(planner.drawHeaderCurrent[0]).toBe(0);
  });

  it("draws the previous-scale label until the settled-scale label is ready", () => {
    const view = records(4);
    view.active[0] = 1;
    view.ready[0] = 1;
    view.kind[0] = 1;
    view.rasterScale[0] = 1;
    view.epoch[0] = 1;
    view.width[0] = 512;
    view.height[0] = 42;
    const planner = new TileSetPlanner(view, 4);
    planner.setHeaderHeight(42);
    planner.setAtRestScale(2);
    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 2,
      devicePixelRatio: 1,
      gestureActive: false,
      epoch: 2,
      recordCount: 1,
    });

    expect(planner.drawHeaderFallbackCount).toBe(1);
    expect(planner.drawHeaderFallback[0]).toBe(0);
    expect(planner.drawHeaderCurrentCount).toBe(0);
  });
});

describe("TileSetPlanner draw set", () => {
  it("uses coarse requests for a zoom-out from 4.0 to 1.0", () => {
    const { planner } = plannerWith(8, 1);
    buildPlanner(planner, {
      contentWidth: 4096,
      contentHeight: 4096,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 1024,
      visibleBottom: 1024,
      zoom: 1,
      devicePixelRatio: 2,
      gestureActive: true,
      epoch: 1,
      recordCount: 0,
    });
    expect(planner.requestedScale).toBe(2);
    expect(planner.requestCount).toBe(16);
    expect(planner.requestCount).toBeLessThanOrEqual(
      computeTilePoolCapacity(1024, 1024, 2),
    );
  });

  it("draws a previous-scale tile underneath an unready replacement", () => {
    const { planner } = plannerWith(1, 1);
    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 2,
      devicePixelRatio: 1,
      gestureActive: false,
      epoch: 2,
      recordCount: 1,
    });
    expect(planner.drawFallbackCount).toBe(1);
    expect(planner.drawCurrentCount).toBe(0);
    expect(planner.missingTile).toBe(false);
  });

  it("draws an older epoch underneath a content replacement", () => {
    const { planner } = plannerWith(1, 3);
    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 1,
      devicePixelRatio: 1,
      gestureActive: false,
      epoch: 4,
      recordCount: 1,
    });
    expect(planner.drawFallbackCount).toBe(1);
    expect(planner.missingTile).toBe(false);
  });
});

describe("TileSetPlanner fully covered fallback", () => {
  it("does not draw an older epoch that is fully covered by current tiles", () => {
    const view = records(4);
    view.active[0] = 1;
    view.ready[0] = 1;
    view.rasterScale[0] = 1;
    view.epoch[0] = 2;
    view.width[0] = 512;
    view.height[0] = 512;
    view.active[1] = 1;
    view.ready[1] = 1;
    view.rasterScale[1] = 1;
    view.epoch[1] = 1;
    view.width[1] = 512;
    view.height[1] = 512;
    const planner = new TileSetPlanner(view, 4);

    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 1,
      devicePixelRatio: 1,
      gestureActive: true,
      epoch: 2,
      recordCount: 2,
    });

    expect(planner.drawCurrentCount).toBe(1);
    expect(planner.drawFallbackCount).toBe(0);
  });
});

describe("TileSetPlanner gap fallback", () => {
  it("draws an older epoch where current tiles leave a gap", () => {
    const view = records(4);
    view.active[0] = 1;
    view.ready[0] = 1;
    view.rasterScale[0] = 1;
    view.epoch[0] = 2;
    view.width[0] = 256;
    view.height[0] = 512;
    view.active[1] = 1;
    view.ready[1] = 1;
    view.rasterScale[1] = 1;
    view.epoch[1] = 1;
    view.width[1] = 512;
    view.height[1] = 512;
    const planner = new TileSetPlanner(view, 4);

    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 1,
      devicePixelRatio: 1,
      gestureActive: false,
      epoch: 2,
      recordCount: 2,
    });

    expect(planner.drawCurrentCount).toBe(1);
    expect(planner.drawFallbackCount).toBe(1);
    expect(planner.drawFallback[0]).toBe(1);
  });
});

describe("TileSetPlanner exact-scale fallback", () => {
  it("does not draw a lower-scale tile covered by a same-epoch exact tile", () => {
    const view = records(4);
    view.active[0] = 1;
    view.ready[0] = 1;
    view.rasterScale[0] = 1;
    view.epoch[0] = 1;
    view.width[0] = 512;
    view.height[0] = 512;
    view.active[1] = 1;
    view.ready[1] = 1;
    view.rasterScale[1] = 0.5;
    view.epoch[1] = 1;
    view.width[1] = 512;
    view.height[1] = 512;
    const planner = new TileSetPlanner(view, 4);

    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 1,
      devicePixelRatio: 1,
      gestureActive: false,
      epoch: 1,
      recordCount: 2,
    });

    expect(planner.drawCurrentCount).toBe(1);
    expect(planner.drawFallbackCount).toBe(0);
  });
});

describe("TileSetPlanner fallback order", () => {
  it("draws fallback records oldest and lowest scale first", () => {
    const view = records(8);
    const recordData = [
      { epoch: 1, scale: 2 },
      { epoch: 2, scale: 1 },
      { epoch: 2, scale: 1.5 },
      { epoch: 2, scale: 2 },
    ];
    const positions = [128, 0, 256, 384];
    recordData.forEach(({ epoch, scale }, index) => {
      view.active[index] = 1;
      view.ready[index] = 1;
      view.rasterScale[index] = scale;
      view.epoch[index] = epoch;
      view.localX[index] = positions[index] ?? 0;
      view.width[index] = 128;
      view.height[index] = 512;
    });
    const planner = new TileSetPlanner(view, 8);
    planner.setAtRestScale(1);
    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 2,
      devicePixelRatio: 1,
      gestureActive: true,
      epoch: 2,
      recordCount: 4,
    });

    expect(
      Array.from(planner.drawFallback.slice(0, planner.drawFallbackCount)),
    ).toEqual([0, 2, 3]);
    expect(
      Array.from(planner.drawCurrent.slice(0, planner.drawCurrentCount)),
    ).toEqual([1]);
  });
});

describe("TileSetPlanner prefetch", () => {
  it("accepts a result at the Text prefetch scale", () => {
    const { planner } = plannerWith(1, 1);
    planner.setPrefetchActive(true);
    planner.setPrefetchRasterScale(1.1);
    planner.setPrefetchBounds(0, 0, 512, 512);
    buildPlanner(planner, {
      ...COMMON,
      zoom: 0.4,
      devicePixelRatio: 2,
      gestureActive: true,
      recordCount: 0,
    });

    expect(planner.isRequested(1.1, 0, 0, 1)).toBe(true);
  });

  it("does not request camera Text Tiles at the Minimap level", () => {
    const { planner } = plannerWith(1, 1);
    planner.setMinimapActive(true);
    buildPlanner(planner, { ...COMMON, gestureActive: true });
    expect(planner.requestCount).toBe(0);
  });

  it("requests exact visible tiles when Text is wanted at Minimap", () => {
    const { planner } = plannerWith(1, 1);
    planner.setMinimapActive(true);
    planner.setTextWanted(true);
    buildPlanner(planner, { ...COMMON, gestureActive: false });

    expect(planner.requestedScale).toBe(1);
    expect(planner.requestCount).toBe(4);
  });

  it("uses the coarse gesture scale when Text is wanted at Minimap", () => {
    const { planner } = plannerWith(1, 1);
    planner.setMinimapActive(true);
    planner.setTextWanted(true);
    buildPlanner(planner, {
      ...COMMON,
      zoom: 1.7,
      devicePixelRatio: 2,
      gestureActive: true,
    });

    expect(planner.requestedScale).toBe(coarseRasterScale(1.7, 2));
    expect(planner.requestCount).toBeGreaterThan(0);
  });

  it("requests only headers when Text is not wanted at Minimap", () => {
    const { planner } = plannerWith(1, 1);
    planner.setMinimapActive(true);
    buildPlanner(planner, { ...COMMON, gestureActive: false });

    expect(planner.requestCount).toBe(0);
    expect(planner.requestHeaderCount).toBe(1);
  });
});

describe("TileSetPlanner threshold prefetch", () => {
  it("keeps the focus fixed for a threshold view and uses its raster scale", () => {
    const bounds = viewBoundsAtZoom({
      cameraOffsetX: -120,
      cameraOffsetY: -80,
      currentZoom: 0.4,
      targetZoom: 0.55,
      focusX: 400,
      focusY: 300,
      viewportWidth: 800,
      viewportHeight: 600,
    });
    const focusWorldX = (400 + 120) / 0.4;
    const focusWorldY = (300 + 80) / 0.4;
    expect(bounds.left + 400 / 0.55).toBeCloseTo(focusWorldX);
    expect(bounds.top + 300 / 0.55).toBeCloseTo(focusWorldY);

    const { planner } = plannerWith(1, 1);
    planner.setPrefetchActive(true);
    planner.setPrefetchRasterScale(0.55 * 2);
    planner.setPrefetchBounds(0, 0, 512, 512);
    buildPlanner(planner, {
      ...COMMON,
      gestureActive: true,
      recordCount: 0,
    });
    expect(planner.requestedScale).toBe(1);
    expect(
      Array.from(planner.requestScales.slice(0, planner.requestCount)),
    ).toContain(1.1);
  });

  it("requests the zoom-out prefetch window after visible cells", () => {
    const { planner } = plannerWith(1, 1);
    planner.setPrefetchActive(true);
    planner.setPrefetchBounds(512, 0, 1024, 512);
    buildPlanner(planner, {
      contentWidth: 2048,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 512,
      visibleBottom: 512,
      zoom: 2,
      devicePixelRatio: 1,
      gestureActive: true,
      epoch: 1,
      recordCount: 0,
    });

    expect(planner.requestCount).toBe(8);
    expect(planner.requestColumns[0]).toBe(0);
    expect(planner.requestColumns[3]).toBe(1);
    expect(planner.requestColumns[4]).toBe(2);
  });
});
