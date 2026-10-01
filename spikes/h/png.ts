import { inflateSync } from "node:zlib";

export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

function readUint32(bytes: Buffer, offset: number): number {
  return bytes.readUInt32BE(offset);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance)
    return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

export function decodePng(bytes: Buffer): Rgba {
  if (
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    throw new Error("Expected a PNG screenshot");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    const length = readUint32(bytes, offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      if (data[8] !== 8 || (data[9] !== 6 && data[9] !== 2))
        throw new Error("Only 8-bit RGB/RGBA PNGs are supported");
      channels = data[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") compressed.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(compressed)));
  const stride = width * channels;
  const packed = new Uint8Array(width * height * channels);
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset++] ?? 0;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const source = raw[rawOffset++] ?? 0;
      const left = x >= channels ? (packed[rowStart + x - channels] ?? 0) : 0;
      const up = y > 0 ? (packed[rowStart - stride + x] ?? 0) : 0;
      const upperLeft =
        y > 0 && x >= channels
          ? (packed[rowStart - stride + x - channels] ?? 0)
          : 0;
      packed[rowStart + x] =
        filter === 0
          ? source
          : filter === 1
            ? (source + left) & 255
            : filter === 2
              ? (source + up) & 255
              : filter === 3
                ? (source + Math.floor((left + up) / 2)) & 255
                : (source + paeth(left, up, upperLeft)) & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1)
      data[pixel * 4 + channel] = packed[pixel * channels + channel] ?? 0;
    data[pixel * 4 + 3] =
      channels === 4 ? (packed[pixel * channels + 3] ?? 255) : 255;
  }
  return { width, height, data };
}
