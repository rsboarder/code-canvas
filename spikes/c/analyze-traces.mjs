import { resolve } from "node:path";
import process from "node:process";
import { Console } from "node:console";

import { analyzeTraceEvents, loadTraceEvents } from "./trace-analysis.mjs";

const DEFAULT_ACTIONS = [
  "typing",
  "paste-500-lines",
  "undo",
  "model-switching",
];
const output = new Console(process.stdout, process.stderr);

async function analyze(path) {
  const events = await loadTraceEvents(path);
  const label = path.split("/").pop()?.replace(".json.gz", "") ?? path;
  return analyzeTraceEvents(events, label);
}

const paths = process.argv.slice(2);
const actions =
  paths.length > 0
    ? paths
    : DEFAULT_ACTIONS.map((action) => `spikes/c/results/${action}.json.gz`);
for (const path of actions) {
  const absolutePath = resolve(path);
  output.log(`[spike-c] offline trace analysis ${absolutePath}`);
  output.log(JSON.stringify(await analyze(absolutePath)));
}
