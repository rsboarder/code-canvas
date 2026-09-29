# Spike G — text sharpness at fractional zoom

## Question

At zooms 0.4–4.0 on a DPR 2 display, does a discrete-size glyph atlas remain sharper and cheaper to switch than an MSDF approach? Which raster sizes should the renderer prepare, and what happens when a size boundary is crossed during a continuous zoom?

## Method

`spikes/g/index.html` renders the same 18-line region from `fixtures/reference-dataset/group-00/widget-000.tsx` in two canvases. The left canvas uses an alpha bitmap atlas rendered at the nearest raster size that is not smaller than `14px × Zoom`; the right uses a labeled single-channel signed-distance-field stand-in. The stand-in uses an in-browser two-pass distance transform over glyph masks because no MSDF generator is in the allowed dependency list. It is not an MSDF implementation.

`spikes/g/measure.ts` starts Vite, launches system Chrome headed at `deviceScaleFactor: 2`, asserts that the page is ready and the dataset file was loaded, captures both canvases at the required zooms, then measures rAF intervals and render duration while crossing atlas boundaries in two modes:

* `mid-gesture`: the new atlas is built and selected as soon as the target size changes.
* `debounced`: the current atlas stays selected through the gesture; the new size is built 160 ms after the gesture ends.

Each switch record includes `buildMs`, its rasterization and upload components, the count of distinct glyphs present in the measured text region, and the frame number/timestamp at which the prepared atlas became active. `buildMs` is measured from the start of text rasterization through the copy into the uploaded atlas canvas; cached atlas hits do not create switch records.

The page includes a `Copy results as JSON` button for recording manual observations. The raw screenshot and JSON paths below are produced by `measure.ts`; `results/` is gitignored and is not expected to exist until the measurement is run.

## Environment

The intended measurement environment is the Reference Environment: the built-in 120 Hz ProMotion display, stable Chrome with no frame-rate or vsync flags, full-screen on AC power, DPR 2, and the generated Reference Dataset. The automated wrapper uses `channel: "chrome"`, `headless: false`, a 1200×720 CSS-pixel viewport, and asserts `window.devicePixelRatio === 2`.

The lead's valid capture metadata is DPR 2, `datasetAvailable: true`, and source `fixtures/reference-dataset/group-00/widget-000.tsx`. The existing PNG paths below are the lead-run artifacts. Those PNGs predate the raw-source and region-clipping fixes and therefore carry the transpiled-text caveat; the lead will replace them after rerunning this version.

The capture guard now writes all zoom PNGs before checking pixels and reports every failure together at the end. The earlier right-edge failure was a guard false positive: long dataset rows legitimately reach the canvas edge, but the old check counted foreground in every row. The corrected check counts edge foreground only outside the page-reported rendered text-line bands. The renderer already clips both representations to the same text region; no real stray mark was established by the available log, so no additional renderer change was needed for this issue.

## Results

### Screenshot matrix

The following files are generated for each zoom. Sharpness is deliberately a human judgment; the table records the required capture and its status.

| Zoom | Discrete atlas | SDF stand-in | Dataset/text source | Sharpness verdict |
|---:|---|---|---|---|
| 0.40 | `spikes/g/results/atlas-0-40.png` | `spikes/g/results/sdf-stand-in-0-40.png` | `fixtures/reference-dataset/group-00/widget-000.tsx` | not measured — needs human visual comparison |
| 0.50 | `spikes/g/results/atlas-0-50.png` | `spikes/g/results/sdf-stand-in-0-50.png` | `fixtures/reference-dataset/group-00/widget-000.tsx` | not measured — needs human visual comparison |
| 0.75 | `spikes/g/results/atlas-0-75.png` | `spikes/g/results/sdf-stand-in-0-75.png` | `fixtures/reference-dataset/group-00/widget-000.tsx` | not measured — needs human visual comparison |
| 1.00 | `spikes/g/results/atlas-1-00.png` | `spikes/g/results/sdf-stand-in-1-00.png` | `fixtures/reference-dataset/group-00/widget-000.tsx` | not measured — needs human visual comparison |
| 1.33 | `spikes/g/results/atlas-1-33.png` | `spikes/g/results/sdf-stand-in-1-33.png` | `fixtures/reference-dataset/group-00/widget-000.tsx` | not measured — needs human visual comparison |
| 1.50 | `spikes/g/results/atlas-1-50.png` | `spikes/g/results/sdf-stand-in-1-50.png` | `fixtures/reference-dataset/group-00/widget-000.tsx` | not measured — needs human visual comparison |
| 2.00 | `spikes/g/results/atlas-2-00.png` | `spikes/g/results/sdf-stand-in-2-00.png` | `fixtures/reference-dataset/group-00/widget-000.tsx` | not measured — needs human visual comparison |
| 3.00 | `spikes/g/results/atlas-3-00.png` | `spikes/g/results/sdf-stand-in-3-00.png` | `fixtures/reference-dataset/group-00/widget-000.tsx` | not measured — needs human visual comparison |
| 4.00 | `spikes/g/results/atlas-4-00.png` | `spikes/g/results/sdf-stand-in-4-00.png` | `fixtures/reference-dataset/group-00/widget-000.tsx` | not measured — needs human visual comparison |

No post-fix capture set is certified clean in this worktree: the available PNGs are the pre-fix lead artifacts noted above. The next reference-machine run will replace every row and the guard will preserve all nine pairs even if one or more checks fail. The human must judge sharpness from the regenerated pairs, especially 0.4–0.75 and immediately around each raster boundary; the measured frame and switch numbers below remain recorded for comparison.

### Atlas size set and selection

| Metric | Result |
|---|---|
| Candidate raster sizes | 8, 12, 16, 24, 32, 48, 64, 96 CSS px |
| Selection rule | nearest size that is not smaller than `14px × Zoom`, capped at 96 px |
| Neighbor preparation | not measured — needs reference-Mac implementation profiling; the page lazily builds sizes to expose the switch cost |
| Rasterization cost | measured in the switch table below; the pre-fix run is retained with the transpiled-text caveat |

### Steady-state frame breakdown

After preparation, each frame clears and paints each canvas background, draws one prepared discrete-atlas image and one prepared SDF-atlas image, then updates the caption. It does not rasterize glyphs, run a distance transform, call `getImageData`, rebuild an atlas, or upload a new atlas. A raster-size switch performs the bounded atlas rasterization and upload before the draw; the SDF layer is prepared once and scaled from that prepared layer during zoom. Both canvases use the same first `MAX_REGION_COLUMNS` characters from the same source lines, so their visible text region is like for like.

### Frame and switch metrics

Measured 2026-09-28, Playwright headed Chrome, DPR 2, lead's run; transpiled-text caveat. These frame values are retained for comparison and must be replaced by the lead after this raw-source and edge-bleed fix.

| Mode | Frames observed | Worst render frame | p99 render frame | Worst rAF interval | Intervals > 12.5 ms | Worst atlas build |
|---|---:|---:|---:|---:|---:|---:|
| Mid-gesture switch | 189 | 1.5 ms | 0.3 ms | 9.4 ms | 0 | 2.3 ms |
| Debounced after gesture | 190 | 1.5 ms | 0.3 ms | 9.3 ms | 0 | 0.8 ms |

### Switch records

Measured 2026-09-28, Playwright headed Chrome, DPR 2, lead's run; transpiled-text caveat. `buildMs` includes rasterization plus the uploaded-atlas canvas copy for the 68 distinct glyphs used in the measured region.

| Mode | Transition | buildMs | rasterMs | uploadMs | Landed frame |
|---|---|---:|---:|---:|---:|
| Mid-gesture | 8 → 12 | 1.3 ms | 0.4 ms | 0.8 ms | 4 |
| Mid-gesture | 12 → 16 | 1.9 ms | 0.4 ms | 1.4 ms | 12 |
| Mid-gesture | 16 → 24 | 1.7 ms | 0.3 ms | 1.4 ms | 20 |
| Mid-gesture | 24 → 32 | 2.0 ms | 0.4 ms | 1.5 ms | 36 |
| Mid-gesture | 32 → 48 | 2.3 ms | 0.3 ms | 1.8 ms | 52 |
| Debounced | 8 → 48 | 0.8 ms | 0.7 ms | 0.1 ms | 100, 4746.9 ms timestamp |

The wrapper reports render duration, not GPU time or DevTools presented-frame status. GPU time is not measured — needs a reference-Mac DevTools trace or the eventual performance harness. Dropped and partially presented frames are not measured — needs the same trace classification used by the performance harness. The table values are the lead's pre-fix-source run and must be replaced after the raw-source fix is rerun.

No new automated result files were produced in this sandbox: the attempted `tsx` run was blocked before Vite startup by `listen EPERM` on the sandbox-local tsx IPC pipe. The lead should rerun the wrapper on the reference machine after this fix.

## Manual steps

1. Run `pnpm fixtures` from the repository root.
2. Run `pnpm tsx spikes/g/measure.ts` on the Reference MacBook with the built-in display active, Chrome visible, AC power connected, and no frame-rate or vsync flags.
3. Confirm the JSON state says `datasetAvailable: true`, `devicePixelRatio: 2`, and `sourcePath` is the Reference Dataset path. Do not judge fallback text captures.
4. Inspect each paired PNG at 1:1 and record which representation is sharper at each zoom, especially 0.4–0.75 and just above each raster boundary.
5. Run the page at `/spikes/g/`, perform a continuous zoom across a raster boundary once with `mid-gesture` and once with `debounced`, then press `Copy results as JSON`. Save the copied observation with the report or enter the measured values in the frame table.
6. Record a DevTools Performance trace for both continuous zooms and add presented, partially presented, dropped, long-interval, main-thread, and GPU observations. The page’s rAF metrics alone do not classify compositor frame status.
7. If the visual verdict or trace contradicts the proposed discrete-atlas default, stop before task 2.8 and ask the lead to resolve the design decision.

## Verdict

Lead check (2026-09-29, 1:1 crops): the discrete atlas is sharp at 0.5, 1.33 and 3.0; the SDF stand-in breaks CJK glyphs at 1.33 and steps at 3.0. The paired captures are not at the same scale (the atlas and SDF pages frame the text differently), so this is a per-representation judgement, not a pixel diff. The discrete atlas is adopted (design D6).

The proposed default is a discrete-size atlas with raster sizes **8, 12, 16, 24, 32, 48, 64, and 96 CSS px**, selecting the nearest size that is not smaller than the target. The atlas should switch only after the gesture ends; neighboring sizes should be prepared ahead of time through the budgeted residency queue. This preserves the bitmap hinting advantage at small monospace sizes and avoids doing rasterization or atlas upload work on a zoom frame.

MSDF remains an alternative only if the required screenshot review finds a meaningful sharpness failure in the discrete set. The corrected single-channel SDF stand-in now renders glyph shapes rather than solid bars, so it is useful for directional comparison and frame-cost exploration, but it does not retire the MSDF question because a production MSDF generator is absent. A likely dependency to evaluate, if the lead authorizes adding one later, is `msdfgen` (or a WASM/browser build of it); adding it is outside this spike’s allowed dependency list.

## What this proposes for `design.md`

Update D6 so the discrete atlas is the selected approach, with the raster set above, nearest-not-smaller selection, no atlas-size changes during an active gesture, and neighboring sizes prepared ahead of time through the budgeted queue. Keep MSDF as the rejected/alternative comparison until the human screenshot verdict and reference trace are available.

## Open questions

* not measured — needs the Reference MacBook run to determine whether 8/12 px or 12/16 px gives the better small-text hinting trade-off.
* not measured — needs DevTools trace classification for dropped and partially presented frames during both switch modes.
* not measured — needs GPU timing from the reference harness; this page only reports CPU render duration and rAF intervals.
* The production font metrics and the exact atlas packing/page size remain open until the bundled-font implementation is available.
