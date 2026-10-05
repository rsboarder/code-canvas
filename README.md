# Code Canvas

Code Canvas is a web canvas in Chrome where every TypeScript file (`.ts` or `.tsx`) in a chosen Workspace Folder is a Widget with syntax highlighting. You can pan the Board, zoom with Detail Levels, drag and resize Widgets, use Content Scroll, and edit in the Editor powered by Monaco. The target is 120 frames per second in every interaction. See the [product specifications](openspec/changes/code-canvas/specs/) and [glossary](CONTEXT.md) for the complete behavior and terms.

## Requirements

- macOS with a 120 Hz ProMotion display for the performance target.
- Google Chrome. Use the version in the [Reference Environment](perf/ENVIRONMENT.md).
- Node.js version `22` from [.nvmrc](.nvmrc).
- pnpm.
- Chrome's File System Access API, which the app uses to open local folders.

## Running it

Install dependencies and start the app:

```sh
pnpm install
pnpm dev
```

Open the printed URL in Chrome and select **Open folder**. After a reload, the toolbar offers **Reopen `<folder>`** for the last opened Workspace Folder. The reopen behavior is implemented in [src/app/folder-actions.ts](src/app/folder-actions.ts).

To create the Reference Dataset, run:

```sh
pnpm fixtures
```

This writes `fixtures/reference-dataset/`, a deterministic set of 200 Source Files with 2,000 lines each, and `fixtures/edge-case-corpus/`, a small correctness corpus with unusual line endings, a byte-order mark, blank and empty files, very long lines, and wide characters.

## Using the canvas

- Use two-finger trackpad scrolling or the mouse wheel to pan. Drag empty space, or hold Space while dragging, to pan.
- Pinch, or use Ctrl/Cmd plus the mouse wheel, to zoom toward the cursor.
- Click **Fit all** or press Shift+1 to fit every Widget. Click **100%** or press Shift+0 to set Zoom to 1.0.
- Drag a Widget by its header to move it. Drag its right edge, bottom edge, or corner to resize it.
- At the **Text** Detail Level, scroll inside a Widget to use Content Scroll.
- Double-click a line to start an Editing Session. Press Escape, click outside, pan, or zoom to leave it. Edits are saved to disk automatically.
- At the **Minimap** Detail Level, double-click a Widget to zoom to it instead of editing it.
- Press Shift+M to toggle the metrics overlay.

These controls follow [src/interaction/gesture-targeting.ts](src/interaction/gesture-targeting.ts) and the [specifications](openspec/changes/code-canvas/specs/).

## Reference environment

The Frame Budget is judged on the machine, browser, display, power, profile, and production preview described in the [Reference Environment](perf/ENVIRONMENT.md). That file also defines the Noise Floor and the conditions that make a measurement valid.

## Measuring performance

Run the performance commands from the repository root:

- `pnpm perf` runs the full frame measurement for all scenarios. Run it on the Reference Environment with a visible Chrome window and Low Power Mode off. Use `pnpm perf --scenario '<name>'` to run one scenario.
- `pnpm perf:quick` runs the fast subset of scenarios with the full frame-measurement mode.
- `pnpm perf:stages` measures Frame Stage timings in Chrome and is marked **not a frame measurement**.
- `pnpm perf:self-test` checks that synthetic main-thread and GPU load is detected and that a clean run does not produce a false failure.
- `pnpm perf:baseline` updates `perf/baseline.json` from the newest full report after interactive confirmation. A human confirms the update.

The full, quick, and stage harness runs create `perf/results/<ISO-timestamp>-<mode>/`. Each measured scenario writes a `.json.gz` trace there; the run also writes `report.json` and `report.md`. Full reports therefore have the form `perf/results/<ISO-timestamp>-full/report.json`, and stage reports have the form `perf/results/<ISO-timestamp>-stages/report.json`. The self-test writes its report under `perf/results/<ISO-timestamp>-self-test/`. A full report can be selected explicitly for a baseline update with `PERF_REPORT_PATH`.

For harness verdicts, exit code `0` means passed, `1` means failed, and `2` means the measurement is invalid. A successful `pnpm perf:stages` run has the `stage-passed` verdict and exit code `3`. `pnpm perf:baseline` exits `0` only after a TTY confirmation of `y`; without that confirmation it exits `1`. Startup or report-reading errors use exit code `2`. Thresholds are in [perf/budgets.json](perf/budgets.json).

## Reproducing a measurement in DevTools

1. Use a clean Chrome profile without extensions.
2. Start the app, open its URL, and open `fixtures/reference-dataset` as the Workspace Folder.
3. Open DevTools, select **Performance**, and record while performing the gesture or interaction under test.
4. In the **Frames** track, count Dropped and Partially presented frames. On the main thread, look for application tasks longer than 8 ms.
5. Compare the counts and long intervals with the Noise Floor in [perf/ENVIRONMENT.md](perf/ENVIRONMENT.md).
6. A harness trace from `perf/results/` can be loaded into the same Performance panel for comparison with its report.

## Manual acceptance

Once a week, record real-trackpad traces for pan, pinch, and scroll inside a Widget as `perf/acceptance/weekly/<YYYY-MM-DD>-<gesture>.json.gz`. Compare each trace with the latest matching full harness report. The process rules and mismatch handling are in [AGENTS.md](AGENTS.md).

The final acceptance traces for the interactions in the performance specifications belong in `perf/acceptance/` as part of tasks group 13.

## Development

Run the repository checks and end-to-end tests with:

```sh
pnpm check
pnpm test:e2e
```

See [AGENTS.md](AGENTS.md) for the rules that agents and contributors follow, including architecture boundaries, performance constraints, testing, and measurement cadence.
