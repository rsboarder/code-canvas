# Spike B — WebGL2 alpha-only glyph atlas and instancing

> **Status: verdict withdrawn (2026-09-28 review).** The numbers below were measured on a scene that does not match the question, so they do not support D6 either way. Task 2.2 stays open; its load question is answered by spike E (2.6) and its Monaco-alignment question by spike C (2.4).
>
> - All glyphs are assigned to widget 0 by the sequential fill (`spikes/b/main.ts:550-583`), so only about 850 glyphs are visible per frame, not 50k/100k/200k.
> - The glyph advance is divided by the raster scale (`spikes/b/main.ts:469`, used by the shader at `:325`), so text is drawn at half width.
> - The Monaco cross-check uses the unhalved advance (`:832`, `:853`) and samples line 4, which contains no tab or non-ASCII character (`:833`); the 0.56 px deviation therefore says nothing about the rendered frame.
> - Colours are `codePoint % 8`, not tokens.
>
> Still valid: the Monaco 0.57 editor-worker 404 finding and the R8 + data-texture + single-draw-call structure as a starting point.

## Question

Can a single WebGL2 draw call render real Reference Dataset text through an alpha-only glyph atlas while panning, with a fixed instance record containing the widget index, row, column, atlas slot index, and color index? Do tabs, punctuation, JSX, and non-ASCII characters survive the layout path, and do the resulting glyph positions align with Monaco?

## Method

`spikes/b/main.ts` loads all 200 files with Vite's lazy `import.meta.glob` and `?raw`, so `.ts` and `.tsx` files are consumed as exact source text rather than transformed modules. The runner compares the first file's prefix and character length against the corresponding file on disk before measuring. Canvas2D rasterizes the glyph set into a 1024 × 1024 alpha-only atlas at 2× raster scale using the system monospace font `Menlo` (14 CSS px, 21 CSS px line height). The atlas is uploaded as WebGL2 `R8`; widget frames are uploaded to an RGBA32F data texture.

Each instance is five unsigned 32-bit values:

| Field | Meaning |
| --- | --- |
| 0 | widget index |
| 1 | source row |
| 2 | expanded column |
| 3 | atlas slot index |
| 4 | palette color index |

Tabs are expanded to four spaces. Punctuation, JSX syntax, and the dataset's Cyrillic, Japanese, and emoji characters are collected into atlas slots; an empty-font fallback slot is available. The vertex shader reads the widget frame from the data texture, and the fragment shader clips against the widget body rectangle. Depth testing is enabled for stack order. The pan is a scripted `requestAnimationFrame` camera motion lasting at least 5 seconds for each glyph count.

`measure.ts` starts its own Vite server, launches headed Chrome with `deviceScaleFactor: 2`, records the CPU duration of the frame function and every rAF interval, and samples `EXT_disjoint_timer_query_webgl2` when Chrome exposes it. It writes raw JSON to `spikes/b/results/latest.json` and prints a JSON summary.

The Monaco cross-check uses the same `Menlo`, 14 px, 21 px line-height settings and disables ligatures. It samples a real dataset line containing tabs and non-ASCII text, compares Monaco's column x positions with the expanded WebGL cell positions, and compares line-box baselines derived from the same Canvas2D font metrics.

## Verification

| Check | Result |
| --- | --- |
| `pnpm validate` (nested `pnpm check`) | exit 0 |
| Validation tests | 3 files, 20 tests passed |
| Monaco module/CSS resolution | `pnpm exec vite build spikes/b --outDir /private/tmp/spike-b-vite-build` — exit 0; 1248 modules transformed |
| Raw source verification | verified against disk: `group-00/widget-000.tsx`, 318119 characters |
| Shader type audit | vertex and fragment shaders reviewed line by line for explicit int/uint/float operations; Chrome compile completed during the headed run |
| Headed measurement | completed on the reference MacBook with Playwright-launched, headed Chrome |
| Raw measurement artifact | `spikes/b/results/latest.json`; GPU timer `EXT_disjoint_timer_query_webgl2` available |

## Measurement results

### Environment

The measurement ran on the reference MacBook with Chrome channel, headed, DPR 2, 1440×900, not fullscreen; power state and Low Power Mode were not verified.

| Metric | Result |
| --- | --- |
| Browser | Chrome channel, headed |
| Display / refresh rate | reference MacBook; built-in 120 Hz ProMotion display |
| Power state | not verified; Low Power Mode not verified |
| Window | 1440 × 900 viewport, not fullscreen |
| Device scale factor | 2 |
| Font | Menlo, 14 CSS px, 21 CSS px line height |
| Dataset | 200 files × 2000 lines; raw source verified against disk |
| Pan duration | 5200 ms per glyph count |

### Atlas and instance coverage

| Metric | Result |
| --- | --- |
| Atlas format | WebGL2 `R8`; GPU timer query available |
| Atlas slots | collected during the run; the page results view reports the slot count |
| Instance record | 5 × `uint32`, including atlas slot index |
| Tabs | expanded as four spaces |
| Punctuation | included in the measured dataset |
| JSX | included in the measured dataset |
| Non-ASCII | included in the measured dataset |
| Draw calls | 1 per frame at all three glyph counts |

### Pan frame timing

| Glyph count | CPU frame p50 / p95 / p99 / max | GPU frame p50 / p95 / p99 / max | rAF interval p50 / p95 / p99 / max | Frames | Draw calls |
| ---: | --- | --- | --- | ---: | ---: |
| 50,000 | 0.1 / 0.2 / 0.2 / 2.4 ms | 0.96 / 1.17 / 1.24 / 1.86 ms | 8.3 / 8.9 / 9.3 / 41.7 ms (first-gesture warm-up) | 622 | 1 |
| 100,000 | 0.0 / 0.1 / 0.2 / 0.6 ms | 0.71 / 1.50 / 1.62 / 2.22 ms | 8.3 / 9.1 / 9.3 / 9.4 ms | 625 | 1 |
| 200,000 | 0.0 / 0.1 / 0.2 / 1.2 ms | 1.13 / 1.99 / 2.10 / 2.74 ms | 8.3 / 9.0 / 9.3 / 10.4 ms | 625 | 1 |

### Monaco position cross-check

| Metric | Result |
| --- | --- |
| Font family / size / line height | Menlo / 14 CSS px / 21 CSS px |
| Sample | line 4 (JSX); the sample includes the dataset's non-ASCII content |
| Maximum glyph x deviation at zoom 1.0 | 0.5625 CSS px (reported as 0.56 CSS px) |
| Maximum baseline deviation at zoom 1.0 | 0 CSS px |

## Manual steps

1. On the Reference MacBook, run `pnpm fixtures` and confirm the generated dataset passes its verifier.
2. From the worktree, run `pnpm exec tsx spikes/b/measure.ts` with Chrome visible, on AC power, and on the built-in 120 Hz display.
3. Confirm that the output records `deviceScaleFactor: 2`, that the GPU timer query is either present or explicitly `unavailable`, and that each glyph count ran for at least 5 seconds.
4. Open `/spikes/b/` during or after the run and press **Copy results as JSON**. Preserve the copied result with the run artifact if the raw result needs to be shared.
5. Inspect the Monaco sample and the panning canvas visually for tabs, punctuation, JSX, Cyrillic, Japanese, and emoji; record any visible mismatch beside the JSON artifact.

## Verdict

The one-draw-call R8 atlas path fits the 8.33 ms frame budget at 50,000, 100,000, and 200,000 glyphs on the measured reference run. Using GPU p99 as the path margin, the remaining margins are 7.09 ms, 6.71 ms, and 6.23 ms respectively. The measured CPU p99 plus GPU p99 leaves approximately 6.89 ms, 6.51 ms, and 6.03 ms respectively. The rAF p99 is 9.3 ms at all three counts, so this does not prove every displayed frame meets 120 Hz.

The result does not prove trace-classified dropped or partial frames, fullscreen behavior, behavior with Low Power Mode enabled, or behavior under a real trackpad gesture. The 41.7 ms 50k interval is the first-gesture warm-up outlier confirmed at the start of the raw interval data.

## Findings for Spike C and product

- The Monaco cross-check has a 0.5625 CSS px maximum x deviation (reported as 0.56 CSS px) and 0 CSS px baseline deviation. B computes x as an integer expanded column multiplied by Canvas2D's measured `M` advance, while Monaco reports its own cell positions, so a subpixel advance/cell-width mismatch is the likely cause. Spike C must confirm the cause and ensure the Monaco swap does not visibly shift text.
- Monaco 0.57's editor worker request returns `404 /node_modules/common/services/editorWebWorkerMain.js`, producing `Failed to load worker script for label: editorWorkerService` and three `pageerror` events. Configure `MonacoEnvironment.getWorker` (or a Vite worker import) for the product; do not fix it in Spike B.

## Proposed design impact

No change is proposed to `design.md` yet. If the reference run shows the one-call path within budget, it supports D6's R8 atlas, widget-table lookup, shader clipping, and depth-buffer approach. If it misses the frame budget, stop before changing D6 and review the measured CPU/GPU split with the human.

## Open questions

- Is Menlo the font to ship, or should the eventual bundle use a checked-in monospace WOFF2 before the rendering implementation begins?
