import type { FilePath } from "./file-path";

const excludedDirectories = new Set(["node_modules", ".git", "dist", "build"]);

export function isSourceFileName(name: string): boolean {
  return (
    !name.startsWith(".") && (name.endsWith(".ts") || name.endsWith(".tsx"))
  );
}

export function shouldEnterDirectory(name: string): boolean {
  return !name.startsWith(".") && !excludedDirectories.has(name);
}

export function isSourceFilePath(path: FilePath): boolean {
  const segments = path.split("/");
  const fileName = segments[segments.length - 1];
  if (fileName === undefined || !isSourceFileName(fileName)) return false;

  return segments.slice(0, -1).every(shouldEnterDirectory);
}
