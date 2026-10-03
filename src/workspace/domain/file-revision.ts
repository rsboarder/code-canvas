import type { Brand } from "../../shared/domain";

export type FileRevision = Brand<string, "FileRevision">;

function cyrb53(bytes: Uint8Array): number {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;

  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 2654435761);
    second = Math.imul(second ^ byte, 1597334677);
  }

  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^
    Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^
    Math.imul(first ^ (first >>> 13), 3266489909);

  return 4294967296 * (2097151 & second) + (first >>> 0);
}

export function fileRevisionOf(bytes: Uint8Array): FileRevision {
  return `${String(bytes.length)}:${cyrb53(bytes).toString(16)}` as FileRevision;
}
