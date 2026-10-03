import type { Brand } from "../../shared/domain";

export type FilePath = Brand<string, "FilePath">;

export function filePath(value: string): FilePath {
  if (
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new RangeError(`Invalid FilePath: ${value}`);
  }
  return value as FilePath;
}
