import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { MAX_SOURCE_LINES } from "./module-map.mjs";

function trackedStylesheets(): string[] {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "*.css",
      "*.glsl",
    ],
    { encoding: "utf8" },
  );

  return output.split("\0").filter((file) => file.length > 0);
}

export function existingFiles(
  files: readonly string[],
  exists: (file: string) => boolean = existsSync,
): string[] {
  return files.filter(exists);
}

function lineCount(file: string): number {
  const content = readFileSync(file, "utf8");

  if (content.length === 0) {
    return 0;
  }

  const lines = content.split(/\r?\n/u);
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function runCheck(): number {
  const oversizedFiles = existingFiles(trackedStylesheets())
    .map((file) => ({ file, lines: lineCount(file) }))
    .filter(({ lines }) => lines > MAX_SOURCE_LINES);

  for (const { file, lines } of oversizedFiles) {
    console.log(
      `${file}: ${String(lines)} lines (maximum ${String(MAX_SOURCE_LINES)})`,
    );
  }

  return oversizedFiles.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runCheck();
}
