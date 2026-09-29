import assert from "node:assert/strict";
import {
  measureWidgetCoverage,
  summarizeWidgetCoverage,
  textCoverageGuardFails,
  type CoverageRect,
  type CoverageWidget,
} from "./coverage";

const viewport: CoverageRect = { left: 0, top: 0, right: 100, bottom: 40 };
const target: CoverageWidget = {
  index: 1,
  body: viewport,
  lineHeight: 20,
  lineCount: 2,
};
const widgets: readonly CoverageWidget[] = [
  {
    index: 0,
    body: { left: 60, top: 0, right: 100, bottom: 40 },
    lineHeight: 20,
    lineCount: 2,
  },
  target,
];

const visible = measureWidgetCoverage(target, widgets, viewport, (x) => x < 60);
assert.equal(Math.round(visible.visibleFraction * 10), 6);
assert.equal(visible.lineBandCoverage, 1);
assert.equal(visible.wideLineCoverage, 1);

const broken = summarizeWidgetCoverage([
  measureWidgetCoverage(target, widgets, viewport, () => false),
]);
assert.equal(textCoverageGuardFails(broken), true);
process.stdout.write("coverage unit check passed\n");
