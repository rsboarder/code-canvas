# Spike H — corrected glyph atlas vs. Canvas2D widget raster vs. DOM

## Method

`spikes/h/index.html` renders the first 40 lines of
`fixtures/reference-dataset/group-00/widget-000.tsx` in six 360 × 140 CSS-pixel
viewports. The DOM reference is transformed with the requested zoom, with every
grapheme cluster absolutely positioned at the shared `LineLayout` x coordinate.
The atlas variants use WebGL2 textures; the premultiplied mode uses R8 alpha and
`ONE, ONE_MINUS_SRC_ALPHA`, while the straight mode uses RGBA8 white-on-
transparent texels and `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. The phased atlas stores
four horizontal subpixel phases per cluster. The discrete atlas uses G's
nearest-not-smaller raster set: 8/12/16/24/32/48/64/96 CSS px. Canvas2D draws
each grapheme cluster at the same `LineLayout` x position.

The font is taken from `src/shared/font.ts`: `Menlo, Monaco, monospace`, 16 CSS
px, 20 CSS-pixel line height, ligatures disabled, and DPR 2. This is deliberate:
the source definition is the authority for the spike's font configuration.

`spikes/h/measure.ts` starts Vite on a free port and launches headed Chrome with
Playwright's `channel: "chrome"` and `deviceScaleFactor: 2`. It captures a 1:1
PNG for each zoom and variant, plus a nearest-neighbour 4× enlargement of the
fixed 50 × 20 CSS-pixel origin crop. It exhaustively searches shifts from -12
through +12 device pixels and records mean absolute luminance difference, ink
ratio, and mean horizontal gradient ratio. Atlas straight-alpha and
premultiplied-alpha captures are both measured; the lower-luminance-difference
mode is selected for the variant's primary comparison.

The worktree contains a prior capture set from the broken pre-round-2 scene;
those PNGs and its JSON are not valid evidence for this corrected implementation.
Values below therefore remain `not measured` until the lead reruns the harness
on the reference machine after these fixes.

Round 2 makes each WebGL canvas backing store exactly CSS viewport size × DPR,
so its shader resolution is in device pixels without applying DPR twice. The
harness fails with a named `SANITY CHECK FAILED` reason if a selected variant's
best shift reaches ±12 device pixels, or if the zoom-1 stale Canvas2D capture
differs from the fresh Canvas2D capture by more than 2.0 mean luminance.

## Screenshot and comparison matrix

Paths are written under `spikes/h/results/` by the reference run. Each normal
PNG is a 360 × 140 CSS-pixel crop (720 × 280 device pixels at DPR 2); the `-4x`
file is the fixed 50 × 20 CSS-pixel crop enlarged with nearest-neighbour
sampling.

| Zoom | DOM | Atlas exact | Atlas exact + 4 phases | Atlas discrete | Canvas2D | Canvas2D stale |
|---:|---|---|---|---|---|---|
| 0.75 | `dom-0-75.png`, not measured | `atlas-exact-0-75.png`, not measured | `atlas-phased-0-75.png`, not measured | `atlas-discrete-0-75.png`, not measured | `canvas-0-75.png`, not measured | `canvas-stale-0-75.png`, not measured |
| 1.00 | `dom-1-00.png`, not measured | `atlas-exact-1-00.png`, not measured | `atlas-phased-1-00.png`, not measured | `atlas-discrete-1-00.png`, not measured | `canvas-1-00.png`, not measured | `canvas-stale-1-00.png`, not measured |
| 1.37 | `dom-1-37.png`, not measured | `atlas-exact-1-37.png`, not measured | `atlas-phased-1-37.png`, not measured | `atlas-discrete-1-37.png`, not measured | `canvas-1-37.png`, not measured | `canvas-stale-1-37.png`, not measured |
| 2.00 | `dom-2-00.png`, not measured | `atlas-exact-2-00.png`, not measured | `atlas-phased-2-00.png`, not measured | `atlas-discrete-2-00.png`, not measured | `canvas-2-00.png`, not measured | `canvas-stale-2-00.png`, not measured |

The per-zoom comparison values are in `spikes/h/results/summary.json` after the
lead run. At this time, every `(dx, dy)`, luminance difference, ink ratio, and
gradient ratio is **not measured**.

## Cost measurements

All timing values are medians of five runs. Texture memory is the allocated
pixel storage reported by the harness in bytes. The Canvas2D costs include
rasterization and upload; the atlas costs are for the 40-line glyph set at
zoom 1.

| Work | Raster/build (ms) | Upload (ms) | Texture memory (bytes) |
|---|---:|---:|---:|
| Canvas2D, 40 lines | not measured | not measured | not measured |
| Canvas2D, 2000 lines | not measured | not measured | not measured |
| Atlas, exact size, 40-line glyph set | not measured | not measured | not measured |
| Atlas, exact size + phases, 40-line glyph set | not measured | not measured | not measured |

The JSON also preserves separate `buildMs`, `rasterMs`, and `uploadMs` fields
for atlas results and both Canvas2D line counts.

## Interpretation

The visually indistinguishable-at-rest variant is **not measured**. The lead and
human judge should inspect the paired normal and 4× PNGs. The JSON's primary
comparison selects the alpha mode with the smaller shifted mean luminance
difference, but that numerical selection does not replace the visual judgment.

The source of the ink difference is **not measured**. The captures are intended
to distinguish atlas raster-size resampling, horizontal phase quantization,
straight versus premultiplied alpha, Canvas2D's whole-block rasterization, and
the deliberately stale zoom-1 texture. No product-design verdict is made here.
The two alpha paths now have different texture formats and blend states; whether
their final pixels are measurably identical remains **not measured** until the
lead reruns the harness.

## Reproduction

1. Run `pnpm fixtures` from the repository root.
2. On the reference machine, run `pnpm exec tsx spikes/h/measure.ts` with
   visible Chrome, DPR 2, the built-in 120 Hz display, and no frame-rate or
   vsync flags.
3. Confirm the JSON state reports `datasetAvailable: true`, the reference
   dataset path, and `devicePixelRatio: 2`.
4. Inspect all generated normal and 4× captures before recording the visual
   conclusion above.

## Verification

`pnpm check`: exit 0 in this worktree; the repository test run reported 32 test
files and 913 tests passed. The corrected browser harness was not run in this
sandbox; the existing PNG/JSON artifacts are from the pre-fix scene and must be
replaced by the lead's headed Chrome rerun.
