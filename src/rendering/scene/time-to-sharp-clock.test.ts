import { describe, expect, it } from "vitest";

import { TimeToSharpClock } from "./time-to-sharp-clock";

describe("TimeToSharpClock", () => {
  it("starts at Text and reports exact elapsed time once", () => {
    const clock = new TimeToSharpClock();

    clock.zoomGestureEnded(true, 100);

    expect(clock.running).toBe(true);
    expect(clock.check(false, 125)).toBeUndefined();
    expect(clock.running).toBe(true);
    expect(clock.check(true, 140)).toBe(40);
    expect(clock.running).toBe(false);
    expect(clock.check(true, 150)).toBeUndefined();
  });

  it("does not start when a zoom gesture ends at Minimap", () => {
    const clock = new TimeToSharpClock();

    clock.zoomGestureEnded(false, 100);

    expect(clock.running).toBe(false);
    expect(clock.check(true, 140)).toBeUndefined();
  });

  it("cancels when a new zoom gesture starts or Text is left", () => {
    const clock = new TimeToSharpClock();

    clock.zoomGestureEnded(true, 100);
    clock.zoomGestureStarted();
    expect(clock.running).toBe(false);

    clock.zoomGestureEnded(true, 200);
    clock.leftText();
    expect(clock.running).toBe(false);
  });

  it("keeps running when the visible Text is not exact", () => {
    const clock = new TimeToSharpClock();

    clock.zoomGestureEnded(true, 100);

    expect(clock.check(false, 140)).toBeUndefined();
    expect(clock.running).toBe(true);
  });

  it("restarts from the second Text gesture end", () => {
    const clock = new TimeToSharpClock();

    clock.zoomGestureEnded(true, 100);
    clock.zoomGestureEnded(true, 200);

    expect(clock.check(true, 240)).toBe(40);
  });
});
