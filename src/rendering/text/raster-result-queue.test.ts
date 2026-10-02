import { describe, expect, it } from "vitest";

import { RasterResultQueue } from "./raster-result-queue";

describe("RasterResultQueue", () => {
  it("drains in arrival order and clears the returned buffer before reuse", () => {
    const queue = new RasterResultQueue<number>();
    queue.push(1);
    queue.push(2);

    const first = queue.drain();
    expect(first).toEqual([1, 2]);

    queue.push(3);
    expect(queue.drain()).toEqual([3]);
    expect(first).toEqual([]);
  });
});
