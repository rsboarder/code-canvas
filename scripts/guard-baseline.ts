import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const BASELINE_PATH = "perf/baseline.json";

export function baselineChangeAllowed(
  stagedFiles: readonly string[],
  confirmation: string | undefined,
): boolean {
  return !stagedFiles.includes(BASELINE_PATH) || confirmation === "1";
}

function stagedFiles(): string[] {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB"],
    { encoding: "utf8" },
  );

  return output.split("\n").filter((file) => file.length > 0);
}

function runGuard(): number {
  if (
    baselineChangeAllowed(stagedFiles(), process.env.PERF_BASELINE_CONFIRMED)
  ) {
    return 0;
  }

  console.error(
    "perf/baseline.json is staged; set PERF_BASELINE_CONFIRMED=1 after human confirmation",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runGuard();
}
