import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROTECTED_PATHS = ["perf/baseline.json", "perf/budgets.json"] as const;
const APPROVAL_LABEL = "perf-baseline-approved";

export function parseChangedFiles(output: string): string[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    const paths =
      status.startsWith("R") || status.startsWith("C")
        ? fields.slice(1)
        : [fields[1]];
    return paths.filter((file): file is string => Boolean(file));
  });
}

export function protectedChanges(changedFiles: readonly string[]): string[] {
  return PROTECTED_PATHS.filter((path) => changedFiles.includes(path));
}

export function baselineChangeAllowed(
  changedFiles: readonly string[],
  confirmation: string | undefined,
): boolean {
  return protectedChanges(changedFiles).length === 0 || confirmation === "1";
}

function gitChanges(args: readonly string[]): string[] {
  const output = execFileSync("git", [...args], { encoding: "utf8" });
  return parseChangedFiles(output);
}

function stagedFiles(): string[] {
  return gitChanges([
    "diff",
    "--cached",
    "--name-status",
    "--diff-filter=ACDMRTUXB",
  ]);
}

function pullRequestFiles(): string[] | undefined {
  const base = process.env.GITHUB_BASE_SHA;
  const head = process.env.GITHUB_HEAD_SHA;
  if (!base || !head) {
    return undefined;
  }
  return gitChanges([
    "diff",
    "--name-status",
    "--diff-filter=ACDMRTUXB",
    `${base}...${head}`,
  ]);
}

function hasApprovalLabel(eventPath: string | undefined): boolean {
  if (!eventPath) {
    return false;
  }
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { labels?: { name?: string }[] };
    };
    return (
      event.pull_request?.labels?.some(
        (label) => label.name === APPROVAL_LABEL,
      ) === true
    );
  } catch {
    return false;
  }
}

function runGuard(): number {
  const isCi = process.argv.includes("--ci");
  const changed = isCi ? pullRequestFiles() : stagedFiles();
  if (!changed) {
    console.error(
      "CI baseline guard requires GITHUB_BASE_SHA and GITHUB_HEAD_SHA",
    );
    return 1;
  }

  const confirmation = isCi
    ? hasApprovalLabel(process.env.GITHUB_EVENT_PATH)
      ? "1"
      : undefined
    : process.env.PERF_BASELINE_CONFIRMED;
  if (baselineChangeAllowed(changed, confirmation)) {
    return 0;
  }

  console.error(
    "perf/baseline.json or perf/budgets.json changed; set PERF_BASELINE_CONFIRMED=1 locally or add the perf-baseline-approved label in CI",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runGuard();
}
