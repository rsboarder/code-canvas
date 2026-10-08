import { describe, expect, it } from "vitest";

import {
  TileSetPlanner,
  TileRecords,
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
} from "./index";
import {
  coarseRasterScale,
  gestureStepRasterScale,
} from "./text-tile-raster-scale-rule";
import { computeTilePoolCapacity } from "../tile-plan";
import { viewBoundsAtZoom } from "../tile-view-window";

const COMMON = {
  fileId: "file-a",
  filePath: "src/a.ts",
  contentVersion: 1,
  highlighted: false,
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

type RecordInput = readonly [
  scale: number,
  epoch?: number,
  column?: number,
  row?: number,
  contentWidth?: number,
  contentHeight?: number,
  kind?: number,
];

function records(capacity = 32): TileRecords {
  const value = new TileRecords(capacity);
  value.setContentSource(COMMON, 1);
  return value;
}

function addRecord(value: TileRecords, input: RecordInput): number {
  const [
    scale,
    epoch = 1,
    column = 0,
    row = 0,
    contentWidth = COMMON.contentWidth,
    contentHeight = COMMON.contentHeight,
    kind = CONTENT_KIND,
  ] = input;
  value.setContentSource(
    {
      ...COMMON,
      contentWidth,
      contentHeight,
    },
    epoch,
  );
  const record = value.ensureRecord(kind, scale, column, row);
  value.setState(record, "ready", true);
  return record;
}

function plannerWith(scale: number, epoch: number, column = 0, row = 0) {
  const value = records();
  addRecord(value, [scale, epoch, column, row]);
  return {
    view: value.records,
    planner: new TileSetPlanner(value.records, 32),
  };
}

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
    const scale = gestureStepRasterScale(1.7, 1);
    const { view, planner } = plannerWith(scale, 1);
    buildPlanner(planner, {
      contentWidth: 1024,
      contentHeight: 1024,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 256,
      visibleBottom: 256,
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

    expect(planner.requestScale(CONTENT_KIND)).toBeCloseTo(2.74);
  });

  it("clips coverage to a short content edge before sampling", () => {
    const value = records();
    addRecord(value, [1, 1, 0, 0, 512, 100]);
    const planner = new TileSetPlanner(value.records, 32);

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

describe("TileSetPlanner coverage clipping", () => {
  it("does not draw a content tile entirely past the content bottom", () => {
    const value = records();
    addRecord(value, [0.5, 1, 0, 1, 1024, 1124]);
    const planner = new TileSetPlanner(value.records, 32);
    buildPlanner(planner, {
      ...COMMON,
      contentHeight: 100,
      gestureActive: false,
      recordCount: 1,
    });
    expect(planner.drawFallbackCount).toBe(0);
  });

  it("clips a header tile to the header extent", () => {
    const value = records();
    value.setHeaderHeight(42);
    addRecord(value, [0.5, 1, 0, 1, 512, 1024, HEADER_KIND]);
    const planner = new TileSetPlanner(value.records, 32);
    planner.setHeaderHeight(42);
    buildPlanner(planner, { ...COMMON, gestureActive: false, recordCount: 1 });
    expect(planner.drawHeaderFallbackCount).toBe(0);
  });
});

describe("TileSetPlanner gesture requests", () => {
  it("uses the gesture step for headers and labels during a zoom gesture", () => {
    const { planner } = plannerWith(coarseRasterScale(1.7, 2), 1);
    buildPlanner(planner, {
      ...COMMON,
      zoom: 1.7,
      devicePixelRatio: 2,
      gestureActive: true,
      recordCount: 0,
    });

    expect(planner.requestScale(HEADER_KIND)).toBe(
      gestureStepRasterScale(1.7, 2),
    );
    expect(planner.requestScale(LABEL_KIND)).toBe(
      gestureStepRasterScale(1.7, 2),
    );
    expect(planner.requestScale(CONTENT_KIND)).toBe(
      gestureStepRasterScale(1.7, 2),
    );
  });

  it("requests a visible cell when coarse coverage is too mismatched", () => {
    const coarseScale = coarseRasterScale(1.7, 1);
    const stepScale = gestureStepRasterScale(1.7, 1);
    const { view, planner } = plannerWith(coarseScale, 1);
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

    expect(planner.isRequested(stepScale, 0, 0, 1)).toBe(true);
    expect(planner.missingTile).toBe(false);
    expect(view.rasterScale[0]).toBe(coarseScale);
  });

  it("chooses the nearest square-root-of-two gesture step", () => {
    expect(gestureStepRasterScale(1, 2)).toBe(2);
    expect(gestureStepRasterScale(Math.sqrt(Math.sqrt(2)), 1)).toBeCloseTo(
      Math.sqrt(2),
    );
    expect(gestureStepRasterScale(1.3, 1)).toBeCloseTo(Math.sqrt(2));
    expect(gestureStepRasterScale(1.7, 1)).toBe(2);
  });
});

describe("TileSetPlanner empty content", () => {
  it("requests headers but no content for an empty Text document", () => {
    const { planner } = plannerWith(1, 1);
    buildPlanner(planner, {
      ...COMMON,
      contentWidth: 0,
      contentHeight: 0,
      gestureActive: false,
      recordCount: 0,
    });

    expect(planner.requestHeaderCount).toBeGreaterThan(0);
    expect(planner.requestLabel).toBe(false);
    expect(planner.requestCount).toBe(0);
    expect(planner.missingTile).toBe(false);
  });

  it("requests headers and labels for an empty Minimap document", () => {
    const { planner } = plannerWith(1, 1);
    planner.setMinimapActive(true);
    buildPlanner(planner, {
      ...COMMON,
      contentWidth: 0,
      contentHeight: 0,
      gestureActive: false,
      recordCount: 0,
    });

    expect(planner.requestHeaderCount).toBeGreaterThan(0);
    expect(planner.requestLabel).toBe(true);
  });

  it("draws resident headers and labels for an empty document", () => {
    const value = records(4);
    value.setHeaderHeight(42);
    addRecord(value, [1, 1, 0, 0, 1024, 1024, HEADER_KIND]);
    addRecord(value, [1, 1, 0, 0, 1024, 1024, LABEL_KIND]);
    const planner = new TileSetPlanner(value.records, 4);
    planner.setHeaderHeight(42);
    buildPlanner(planner, {
      ...COMMON,
      contentWidth: 0,
      contentHeight: 0,
      gestureActive: false,
      recordCount: 2,
    });

    expect(planner.drawHeaderCurrentCount).toBeGreaterThanOrEqual(1);
    expect(planner.drawLabelCurrentCount).toBeGreaterThanOrEqual(1);
  });
});

describe("TileSetPlanner label draw set", () => {
  it("keeps a resident label tile when the content epoch changes", () => {
    const value = records(4);
    value.setHeaderHeight(42);
    addRecord(value, [1, 1, 0, 0, 1024, 1024, HEADER_KIND]);
    const planner = new TileSetPlanner(value.records, 4);
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
    const value = records(4);
    value.setHeaderHeight(42);
    addRecord(value, [1, 1, 0, 0, 1024, 1024, HEADER_KIND]);
    const planner = new TileSetPlanner(value.records, 4);
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

describe("TileSetPlanner gesture draw set", () => {
  it("draws the closer gesture-scale tile over the old at-rest tile", () => {
    const value = records(4);
    addRecord(value, [1, 1, 0, 0, 512, 512]);
    const gestureScale = gestureStepRasterScale(1.3, 1);
    addRecord(value, [gestureScale, 1, 0, 0, 512, 512]);
    const planner = new TileSetPlanner(value.records, 4);

    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 256,
      visibleBottom: 256,
      zoom: 1.3,
      devicePixelRatio: 1,
      gestureActive: true,
      epoch: 1,
      recordCount: 2,
    });

    expect(
      Array.from(planner.drawCurrent.slice(0, planner.drawCurrentCount)),
    ).toEqual([0, 1]);

    buildPlanner(planner, {
      contentWidth: 512,
      contentHeight: 512,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 256,
      visibleBottom: 256,
      zoom: 1.3,
      devicePixelRatio: 1,
      gestureActive: false,
      epoch: 1,
      recordCount: 2,
    });

    expect(
      Array.from(planner.drawCurrent.slice(0, planner.drawCurrentCount)),
    ).toEqual([0]);
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
    expect(planner.requestScale(CONTENT_KIND)).toBe(2);
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
    const value = records(4);
    addRecord(value, [1, 2, 0, 0, 512, 512]);
    addRecord(value, [1, 1, 0, 0, 512, 512]);
    const planner = new TileSetPlanner(value.records, 4);

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
    const value = records(4);
    addRecord(value, [1, 2, 0, 0, 256, 512]);
    addRecord(value, [1, 1, 0, 0, 512, 512]);
    const planner = new TileSetPlanner(value.records, 4);

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
    const value = records(4);
    addRecord(value, [1, 1, 0, 0, 512, 512]);
    addRecord(value, [0.5, 1, 0, 0, 512, 512]);
    const planner = new TileSetPlanner(value.records, 4);

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
    const value = records(8);
    const recordData: RecordInput[] = [
      [2, 1, 0, 1, 512, 512],
      [1, 2, 0, 0, 128, 512],
      [1.5, 2, 1, 0, 512, 512],
      [2, 2, 1, 0, 512, 512],
    ];
    recordData.forEach((input) => addRecord(value, input));
    const planner = new TileSetPlanner(value.records, 8);
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

describe("TileSetPlanner ranking", () => {
  it("ranks fallback records by epoch, at-rest scale, then raster scale", () => {
    const value = records(8);
    const recordData: RecordInput[] = [
      [2, 1, 0, 0, 256, 256],
      [1, 2, 1, 0, 1024, 512],
      [1.5, 2, 0, 1, 341.3333333333, 682.6666666666],
      [0.5, 1, 1, 0, 2048, 1024],
    ];
    recordData.forEach((input) => addRecord(value, input));
    const planner = new TileSetPlanner(value.records, 8);
    planner.setAtRestScale(1);
    buildPlanner(planner, {
      ...COMMON,
      contentWidth: 2048,
      contentHeight: 1024,
      visibleRight: 2048,
      visibleBottom: 1024,
      epoch: 3,
      gestureActive: false,
      recordCount: 4,
    });
    expect(
      Array.from(planner.drawFallback.slice(0, planner.drawFallbackCount)),
    ).toEqual([3, 0, 2, 1]);
  });

  it("ranks current gesture records by closeness to the gesture target", () => {
    const value = records(8);
    const scales = [1, 2, 1.5];
    scales.forEach((scale) => addRecord(value, [scale, 1, 0, 0, 512, 512]));
    const planner = new TileSetPlanner(value.records, 8);
    planner.setAtRestScale(1);
    buildPlanner(planner, {
      ...COMMON,
      visibleRight: 256,
      visibleBottom: 256,
      zoom: 1.7,
      gestureActive: true,
      recordCount: 3,
    });
    expect(
      Array.from(planner.drawCurrent.slice(0, planner.drawCurrentCount)),
    ).toEqual([0, 1, 2]);
  });
});

describe("TileSetPlanner prefetch", () => {
  it("pins only the explicit Text prefetch scale", () => {
    const { planner } = plannerWith(1, 1);
    planner.setPrefetchActive(true);
    planner.setZoom(1.5, 2, true);

    expect(planner.prefetchScale()).toBe(0);

    planner.setPrefetchZoom(0.55);

    expect(planner.prefetchScale()).toBe(1.1);
  });

  it("accepts a result at the Text prefetch scale", () => {
    const { planner } = plannerWith(1, 1);
    planner.setPrefetchActive(true);
    planner.setPrefetchZoom(0.55);
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

    expect(planner.requestScale(CONTENT_KIND)).toBe(1);
    expect(planner.requestCount).toBe(4);
  });

  it("uses the gesture step scale when Text is wanted at Minimap", () => {
    const { planner } = plannerWith(1, 1);
    planner.setMinimapActive(true);
    planner.setTextWanted(true);
    buildPlanner(planner, {
      ...COMMON,
      zoom: 1.7,
      devicePixelRatio: 2,
      gestureActive: true,
    });

    expect(planner.requestScale(CONTENT_KIND)).toBe(
      gestureStepRasterScale(1.7, 2),
    );
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
    const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    viewBoundsAtZoom(
      {
        cameraOffsetX: -120,
        cameraOffsetY: -80,
        currentZoom: 0.4,
        targetZoom: 0.55,
        focusX: 400,
        focusY: 300,
        viewportWidth: 800,
        viewportHeight: 600,
      },
      bounds,
    );
    const focusWorldX = (400 + 120) / 0.4;
    const focusWorldY = (300 + 80) / 0.4;
    expect(bounds.left + 400 / 0.55).toBeCloseTo(focusWorldX);
    expect(bounds.top + 300 / 0.55).toBeCloseTo(focusWorldY);

    const { planner } = plannerWith(1, 1);
    planner.setPrefetchActive(true);
    planner.setPrefetchZoom(1.1);
    planner.setPrefetchBounds(0, 0, 512, 512);
    buildPlanner(planner, {
      ...COMMON,
      gestureActive: true,
      recordCount: 0,
    });
    expect(planner.requestScale(CONTENT_KIND)).toBe(1);
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
