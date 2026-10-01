import { chmod, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);

const TOOL_URL =
  "https://commondatastorage.googleapis.com/perfetto-luci-artifacts/v58.2/mac-arm64/trace_processor_shell";
const TOOL_SHA256 =
  "d29864d1ba3b36855527bb1b0ca3aa7f703cdce338b9680bb922c5c151b358fa";
const TOOL_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  "results/tools/trace_processor_shell-v58.2-mac-arm64",
);

// v58.2 has no `--csv` flag (that made every run fail, exit 3); run the
// query from a file with `-q` instead. Its default output is already CSV
// with a quoted header.
//
// Each physically displayed frame is reported twice by Chrome's compositor
// under the same frame_reporter.display_trace_id: once as its own
// frame_sequence's STATE_PRESENTED_ALL, and again later as a carry-over
// STATE_PRESENTED_PARTIAL contribution folded into the NEXT frame_sequence
// (same display_trace_id, later ts) — counting rows directly double-counts
// every presented frame. A STATE_DROPPED frame has no display_trace_id
// (NULL), so group by frame_sequence instead for those — grouping by
// display_trace_id alone collapses every dropped frame into one NULL-keyed
// group.
export const PIPELINE_SQL = `
WITH frame_events AS (
  SELECT
    ts,
    dur,
    COALESCE(
      EXTRACT_ARG(arg_set_id, 'frame_reporter.state'),
      EXTRACT_ARG(arg_set_id, 'chrome_frame_reporter.state')
    ) AS state,
    COALESCE(
      EXTRACT_ARG(arg_set_id, 'frame_reporter.frame_sequence'),
      EXTRACT_ARG(arg_set_id, 'chrome_frame_reporter.frame_sequence')
    ) AS frame_sequence,
    COALESCE(
      EXTRACT_ARG(arg_set_id, 'frame_reporter.display_trace_id'),
      EXTRACT_ARG(arg_set_id, 'chrome_frame_reporter.display_trace_id')
    ) AS display_trace_id
  FROM slice
  WHERE name = 'PipelineReporter' AND category GLOB '*cc*' AND depth = 0
),
frames AS (
  SELECT
    COALESCE(CAST(display_trace_id AS TEXT), 'seq-' || CAST(frame_sequence AS TEXT)) AS frame_key,
    MAX(CASE WHEN state = 'STATE_DROPPED' THEN 1 ELSE 0 END) AS any_dropped,
    MAX(CASE WHEN state = 'STATE_PRESENTED_ALL' THEN 1 ELSE 0 END) AS any_all
  FROM frame_events
  GROUP BY frame_key
),
main_tasks AS (
  SELECT MAX(dur) AS longest_main_task_ns
  FROM slice
  WHERE category GLOB '*toplevel*' OR category GLOB '*devtools.timeline*'
)
SELECT
  SUM(CASE WHEN any_dropped = 0 AND any_all = 1 THEN 1 ELSE 0 END) AS presented_all,
  SUM(CASE WHEN any_dropped = 0 AND any_all = 0 THEN 1 ELSE 0 END) AS presented_partial,
  SUM(CASE WHEN any_dropped = 1 THEN 1 ELSE 0 END) AS dropped,
  (SELECT longest_main_task_ns FROM main_tasks) AS longest_main_task_ns
FROM frames;`;

export interface TracePipelineResult {
  readonly presentedAll: number;
  readonly presentedPartial: number;
  readonly dropped: number;
  readonly longestMainTaskMs: number | "not measured";
  readonly sql: string;
}

async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensureTool(): Promise<string> {
  try {
    const toolStat = await stat(TOOL_PATH);
    if (toolStat.isFile() && (await sha256(TOOL_PATH)) === TOOL_SHA256)
      return TOOL_PATH;
  } catch {
    // Download on the lead machine when the pinned tool is not cached.
  }
  await mkdir(dirname(TOOL_PATH), { recursive: true });
  const response = await fetch(TOOL_URL);
  if (!response.ok || !response.body)
    throw new Error(
      `TRACE FAILED: unable to download Perfetto (${String(response.status)})`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== TOOL_SHA256)
    throw new Error("TRACE FAILED: Perfetto checksum mismatch");
  await writeFile(TOOL_PATH, bytes, { mode: 0o755 });
  await chmod(TOOL_PATH, 0o755);
  return TOOL_PATH;
}

function unquoteCsvField(field: string): string {
  return field.startsWith('"') && field.endsWith('"')
    ? field.slice(1, -1)
    : field;
}

export function parseCsvRow(csv: string): Record<string, string> {
  const lines = csv.trim().split(/\r?\n/u);
  const header = (lines[0]?.split(",") ?? []).map(unquoteCsvField);
  const row = (lines[1]?.split(",") ?? []).map(unquoteCsvField);
  return Object.fromEntries(
    header.map((name, index) => [name, row[index] ?? ""]),
  );
}

export async function analyzeTrace(
  tracePath: string,
): Promise<TracePipelineResult> {
  const tool = await ensureTool();
  const queryFile = resolve(
    tmpdir(),
    `h2-pipeline-${String(process.pid)}-${String(Date.now())}.sql`,
  );
  await writeFile(queryFile, PIPELINE_SQL);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(tool, ["-q", queryFile, tracePath]));
  } finally {
    await rm(queryFile, { force: true });
  }
  const row = parseCsvRow(stdout);
  const number = (value: string | undefined): number => Number(value ?? 0);
  const longestNs = number(row.longest_main_task_ns);
  return {
    presentedAll: number(row.presented_all),
    presentedPartial: number(row.presented_partial),
    dropped: number(row.dropped),
    longestMainTaskMs:
      Number.isFinite(longestNs) && longestNs > 0
        ? longestNs / 1_000_000
        : "not measured",
    sql: PIPELINE_SQL.trim(),
  };
}
