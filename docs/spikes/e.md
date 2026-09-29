# Spike E — round 8 final report

## Question

At the worst-case Reference Dataset density, can the Board switch all widgets between Text and Minimap in one frame while zoom crosses a threshold, without an empty frame or incorrect stacking? What preliminary line-height thresholds, hysteresis band, minimap width, and atlas memory should D6 and D8 use?

## Method

`spikes/e/main.ts` loads the 200 Reference Dataset entries with Vite's raw `import.meta.glob` form. The page computes a SHA-256 for every raw string and exposes path, length, prefix, and hash to the runner. `measure.ts` rereads every corresponding file from disk and verifies all four values.

One copied Spike D Monarch worker tokenizes every file and builds its R8 minimap before measurement. The page uploads the minimaps into one shared R8 atlas and prepares Text instances before either pass. Widgets are 600 × 400 CSS px at zoom 1, with a 32 px header and a 368 px body; the 10 × 20 D-grid uses 40 px gaps, and six widgets form the overlapping centre cluster. Text uses a 14 px Menlo monospace font, a 21 px line height, and the Canvas2D `measureText("M")` advance without raster-scale division. Each widget prepares 17 body lines (`floor(368 / 21)`), uses code-point iteration with UTF-16 token offsets, and carries its body clip on every glyph instance. The glyph atlas raster and shader sample use one cell geometry: the cell-origin sample window is `advance × LINE_HEIGHT` at 2× raster scale, with a font-metric baseline inside that line box. No `UNPACK_FLIP_Y_WEBGL` state is used.

The timing pass runs a requestAnimationFrame zoom sweep without screenshots or readbacks. A fixed ring of timer queries resolves GPU results a few frames later. The separate capture pass writes switch and legibility PNGs, then validates dominant colour, gap leakage, and Text coverage. Text coverage is measured only over each widget's on-screen, unoccluded body: the viewport clips the body, higher stack-order body rectangles are subtracted, and bodies under 25% visible area are excluded from the aggregate guard while remaining in per-widget JSON. A pure unit check covers both occlusion geometry and a deliberately blank failing frame.

The runner waits for the exact `[spike-e] ready:` status set by `main.ts`. Build, readiness, pass, trace, and teardown waits are bounded and name the awaited operation on timeout. Console errors, page errors, failed requests, and error responses include diagnostics and URLs. The page declares an empty data favicon.

The first version's trace classifier could not see frame state because its tracing categories omitted `cc`; it also counted event names instead of `PipelineReporter` state, so its zero dropped/partial values were not measurements.

## Preliminary values

These remain provisional until the headed Reference Environment run:

| Value | Proposal | Basis |
| --- | ---: | --- |
| Text → Minimap | 9 device px line height | conservative readability boundary |
| Minimap → Text | 11 device px line height | hysteresis against small zoom changes |
| Hysteresis band | 9–11 device px | 2 device px separation |
| Minimap width | 256 texels | Spike D R8 proposal |
| Minimap height | `min(lines, 512)` | Spike D decimation rule |

For 200 files with 512-line minimap tiles, the 256-wide shared R8 atlas is 5,120 × 5,120 texels and 26,214,400 bytes before implementation-specific GPU allocation overhead. The 128- and 512-wide payloads would be 13,107,200 B and 52,428,800 B respectively.

## Round-8 report

`spikes/e/results/latest.json` contains a top-level `summary` object and the runner prints the same object as one `[spike-e] summary: ...` line. The object reports:

- `densestText`: visible widgets and glyphs plus CPU/GPU p50, p95, and p99;
- `detailSwitches`: switch count, maximum post-switch frame interval, and empty frames;
- `minimapGpuP99` at the threshold window;
- `trace`: presented, dropped, and partial frame counts plus trace presentation intervals over 12.5 ms;
- `atlasMemoryBytes`, `preliminaryThresholds`, and `minimapWidth`.

| Measurement | Result |
| --- | --- |
| Raw files and worker preparation | 200 files, raw text and SHA-256 verified; 227,090 glyph instances prepared |
| Densest Text summary | zoom 0.214 (Text, at the threshold): 86 visible widgets, 97,645 visible glyphs; CPU p50/p95/p99/max 0.1/0.2/0.2/0.3 ms; GPU 1.76/1.83/1.83/1.87 ms; rAF interval p50/p99/max 8.2/9.9/10.4 ms; 0 long frames (12 samples) |
| Switch frames and empty frames | 8 Detail Level flips, worst switch frame 10.6 ms, 0 empty frames |
| Minimap GPU p99 | 1.09 ms |
| Trace frame statuses and long intervals | zoom sweep, corrected classifier (lead re-run 2026-09-29): 701 frames — 699 presented, 1 dropped, 0 partially presented; 0 intervals > 12.5 ms between presented frames; 25,119 main-thread tasks. The first version's "0 dropped / 34 intervals" were artefacts of the old classifier |
| Atlas memory | R8 payload 26,214,400 B (driver allocation not measured) |
| Thresholds and minimap width | proposals 9 px (Text → Minimap) / 11 px (Minimap → Text) device line height, 256 texels; legibility to be confirmed by the human from `legibility-lh*.png` |
| Per-widget expected lines and glyph instances | written to `prepared.widgets[]` |
| Capture guard per-widget visible fractions | written to `capturePass.guards[].samples[].textCoverage.perWidget[]` |

## Pitfalls resolved

- Atlas raster/sampling mismatch: raster text was inset and sampled through a mismatched window, producing cropped glyphs and apparent double spacing. Round 7 made the cell origin, baseline, sample window, and line box agree.
- Readiness predicate mismatch: the runner now waits for the exact `[spike-e] ready:` status and bounds all startup and teardown waits.
- Captures inside the timed loop: timing and capture are separate passes; screenshots and readbacks are absent from timing.
- Coverage overcounting: guards now subtract higher-stack body rectangles and clip to the viewport before evaluating visible text.
- UTF-16/code-point mismatch: glyph iteration advances by code point while token colours read the original UTF-16 offset.

## Verdict

Measured by the lead in headed Chrome on the reference MacBook (2026-09-29, production build, DPR 2), after checking the captures: Text frames show readable, correctly spaced, highlighted code clipped at widget edges with empty gaps and correct overlap; Minimap frames show per-file line structure; all capture guards passed. The worst-case Text frame uses about 1.9 ms of GPU and 0.2 ms of CPU of the 8.33 ms budget, and a Detail Level switch produces no empty frame, so D6's instant switch with one shared Detail Level holds with a wide margin. The corrected trace shows 1 dropped frame of 701 over the zoom sweep and no interval over 12.5 ms; whether that one drop is above the noise floor is judged against spike A's floor. Open: each widget body shows 17 lines (400-unit widgets), so a taller product widget raises the glyph count per widget; the 9/11 px thresholds were checked by the lead on 1:1 crops: readable at 11, degraded but recognisable at 9 — adopted as configuration.

## Design impact for D6 and D8

If the lead confirms the proposals, D6 should switch Text → Minimap at 9 device px and Minimap → Text at 11 device px, preserving the hysteresis band and one Detail Level state change. D8 can use a 256 × `min(lines, 512)` R8 minimap with a 5,120 × 5,120 shared atlas and 26,214,400 B payload for the Reference Dataset. Driver padding/allocation and GPU p99 still require the headed run. Do not crossfade overlapping widgets or use a picture-quality lever to hide a missed frame budget.

## Offline checks

`pnpm validate` passed with the repository checks and 20 tests. The pure coverage unit check passed with `node --import tsx/esm spikes/e/coverage.unit.ts`; `pnpm exec tsx` is blocked by the sandbox IPC socket policy, and the repository has no `jest` command. The production Vite build passed. The headed run and PNG inspection were done by the lead (see Verdict); final D6/D8 decisions belong to task 2.8.
