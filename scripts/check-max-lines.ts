import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_LINES = 800;

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

function lineCount(file: string): number {
  const content = readFileSync(file, "utf8");

  if (content.length === 0) {
    return 0;
  }

  const lines = content.split(/\r?\n/u);
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

const oversizedFiles = trackedStylesheets()
  .map((file) => ({ file, lines: lineCount(file) }))
  .filter(({ lines }) => lines > MAX_LINES);

for (const { file, lines } of oversizedFiles) {
  console.log(`${file}: ${String(lines)} lines (maximum ${String(MAX_LINES)})`);
}

process.exitCode = oversizedFiles.length > 0 ? 1 : 0;
