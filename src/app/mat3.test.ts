import { describe, expect, it } from "vitest";

import {
  identity,
  invert,
  multiply,
  transformPoint,
  type Mat3,
} from "../shared/geometry";

function translation(x: number, y: number): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, x, y, 1]);
}

function scale(sx: number, sy: number): Mat3 {
  return new Float32Array([sx, 0, 0, 0, sy, 0, 0, 0, 1]);
}

describe("identity", () => {
  it("writes the identity matrix into out and returns it", () => {
    const out = new Float32Array(9);
    const result = identity(out);
    expect(result).toBe(out);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe("multiply", () => {
  it("composes a translation and a scale: out = a * b", () => {
    const out = new Float32Array(9);
    const result = multiply(translation(10, 20), scale(2, 3), out);
    expect(result).toBe(out);

    const transformed = transformPoint(out, { x: 1, y: 1 }, { x: 0, y: 0 });
    expect(transformed).toEqual({ x: 1 * 2 + 10, y: 1 * 3 + 20 });
  });
});

describe("invert", () => {
  it("inverts a matrix so that m * invert(m) is the identity", () => {
    const m = multiply(translation(5, -7), scale(2, 4), new Float32Array(9));
    const inverse = invert(m, new Float32Array(9));
    if (inverse === null) {
      throw new Error("expected an invertible matrix");
    }

    const roundTrip = multiply(m, inverse, new Float32Array(9));
    expect(
      Array.from(roundTrip).map((value) => Math.round(value * 1e6) / 1e6),
    ).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("returns null for a singular matrix", () => {
    const singular = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(invert(singular, new Float32Array(9))).toBeNull();
  });
});

describe("transformPoint", () => {
  it("applies the matrix to a point and writes into out", () => {
    const out = { x: 0, y: 0 };
    const result = transformPoint(translation(3, 4), { x: 1, y: 2 }, out);
    expect(result).toBe(out);
    expect(out).toEqual({ x: 4, y: 6 });
  });
});
