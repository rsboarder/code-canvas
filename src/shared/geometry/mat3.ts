import type { Vec2 } from "./geometry";

export type Mat3 = Float32Array;

type Components = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function components(m: Mat3): Components {
  return [
    m[0] ?? 0,
    m[1] ?? 0,
    m[2] ?? 0,
    m[3] ?? 0,
    m[4] ?? 0,
    m[5] ?? 0,
    m[6] ?? 0,
    m[7] ?? 0,
    m[8] ?? 0,
  ];
}

export function identity(out: Mat3): Mat3 {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 1;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[8] = 1;
  return out;
}

export function multiply(a: Mat3, b: Mat3, out: Mat3): Mat3 {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = components(a);
  const [b00, b01, b02, b10, b11, b12, b20, b21, b22] = components(b);

  out[0] = b00 * a00 + b01 * a10 + b02 * a20;
  out[1] = b00 * a01 + b01 * a11 + b02 * a21;
  out[2] = b00 * a02 + b01 * a12 + b02 * a22;

  out[3] = b10 * a00 + b11 * a10 + b12 * a20;
  out[4] = b10 * a01 + b11 * a11 + b12 * a21;
  out[5] = b10 * a02 + b11 * a12 + b12 * a22;

  out[6] = b20 * a00 + b21 * a10 + b22 * a20;
  out[7] = b20 * a01 + b21 * a11 + b22 * a21;
  out[8] = b20 * a02 + b21 * a12 + b22 * a22;

  return out;
}

export function invert(a: Mat3, out: Mat3): Mat3 | null {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = components(a);

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;

  const det = a00 * b01 + a01 * b11 + a02 * b21;
  if (det === 0) {
    return null;
  }
  const invDet = 1 / det;

  out[0] = b01 * invDet;
  out[1] = (-a22 * a01 + a02 * a21) * invDet;
  out[2] = (a12 * a01 - a02 * a11) * invDet;
  out[3] = b11 * invDet;
  out[4] = (a22 * a00 - a02 * a20) * invDet;
  out[5] = (-a12 * a00 + a02 * a10) * invDet;
  out[6] = b21 * invDet;
  out[7] = (-a21 * a00 + a01 * a20) * invDet;
  out[8] = (a11 * a00 - a01 * a10) * invDet;

  return out;
}

export function transformPoint(m: Mat3, point: Vec2, out: Vec2): Vec2 {
  const [m0, m1, , m3, m4, , m6, m7] = components(m);
  const x = point.x;
  const y = point.y;
  out.x = m0 * x + m3 * y + m6;
  out.y = m1 * x + m4 * y + m7;
  return out;
}
