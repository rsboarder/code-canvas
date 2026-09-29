# Spike C — Monaco editing swap

## Question

Can a single Monaco editor sit over the WebGL code widget without a visible
glyph-column, baseline, or scroll jump, while the swap and edit paths remain
compatible with the 120 Hz budget?

## Method

The spike uses a headed Chrome run at 1440 × 900, device scale factor 2, and
the Reference Dataset. Monaco 0.57 is loaded through `editor/editor.api.js`;
TypeScript is registered explicitly with its Monarch grammar, with no
TypeScript language-service worker. The WebGL before-frame and Monaco after-
frame use the same clipped Playwright screenshot path.

The WebGL renderer is an instanced WebGL2 R8 glyph atlas. Atlas slots are
rasterized at the current zoom and sized from each glyph's measured Monaco
advance. The same `layoutLine()` prefix sums feed both instance placement and
the pixel-comparison sample. ASCII and narrow glyphs use Monaco's
`fontInfo.typicalHalfwidthCharacterWidth`; non-ASCII glyphs use their measured
per-code-point width. Tabs advance to the next multiple of the file model's
`getOptions().tabSize`, expressed in that half-width advance.

The sample reports the source text and, for the first 40 source columns, each
glyph's prefix-sum offset and advance. Pixel comparisons retain the WebGL and
Monaco ink x positions plus their Δx for every sampled column, so the tabs
line can be diagnosed on both sides instead of reducing the result to one
aggregate number.

## Environment and measured layout findings

| Item | Finding |
| --- | --- |
| Browser | Chrome channel, headed; lead run 2026-09-29 |
| Viewport / DPR | 1440 × 900 / 2 |
| Monaco advance source | `fontInfo.typicalHalfwidthCharacterWidth` = 8.43 CSS px at zoom 1 |
| Baseline | DOM baseline probe = 15 px; Canvas2D formula = 15.5 px at 21 px line height; DOM value is used |
| Wide glyphs | Cyrillic measures about one narrow cell; 東/京/🧭 measure about 14–15 px, approximately 1.7 cells, not a snapped 2-cell width |
| Atlas | R8 alpha atlas; the 🧭 emoji is expected to appear as a solid token-coloured silhouette |
| Tab model | File model tab size = 4; synthetic `ab\tcd\tefgh` probe agrees with Monaco within 0.44 CSS px in the lead run |

The wide-glyph result is the important design finding: D4 `LineLayout` must
store per-code-point advances and prefix sums, not only integer cell counts.
The R8 atlas intentionally preserves alpha coverage rather than colour emoji
layers; colour emoji therefore render as silhouettes. That is the D6 atlas
trade-off, not a layout defect.

## Results

The lead's capture reported the following frame ranges across runs. The task
duration values are from `spikes/c/results/latest.json` under
`actions.*.trace`.

Final headed run by the lead (2026-09-29 06:23, screen active — spike E ran normally just before it):

| Action | Frames total / presented / dropped / partial | Max main-thread task (ms) | Tasks > 8.33 ms | Input → next paint (ms) |
| --- | --- | ---: | ---: | --- |
| Typing (human rate) | 406 / 231 / 1 / 0 | 11.8 | 1 | event timing p95 27.4, max 34.8 |
| Paste 500 lines | 190 / 5 / 1 / 1 | 11.7 | 2 | 40 |
| Undo | 186 / 3 / 1 / 1 | 9.9 | 1 | 40 |
| Model switching | 189 / 15 / 2 / 1 | 10.1 | 1 | 32 |

"Presented" counts only frames with new content; the short actions are mostly idle frames, so low presented counts are not drops. Earlier runs (different harness code) showed max tasks of 8.8–21.5 ms and 0–13 dropped frames while typing, so the variance between runs is large. The in-page Long Tasks observer reported no task ≥ 50 ms. The tasks > 8.33 ms are seen in the trace; this spike does not separate Monaco's own work from the harness's (keep-alive rendering, tracing overhead).

Pixel alignment, final renderer (max deviation in device px, DPR 2; x / baseline):

| Zoom | ASCII | CJK + emoji | Tabs |
| --- | --- | --- | --- |
| 0.8 | 1.91 / 3 | 1.92 / 8 | 2.31 / 8 |
| 1.0 | 1.84 / 2 | 2.50 / 2 | 2.23 / 2 |
| 1.37 | 2.32 / 2 | 2.59 / 3 | 2.85 / 3 |
| 2.0 | 2.00 / 2 | 3.09 / 2 | 2.52 / 2 |

So x stays within ~1.5 CSS px everywhere; the baseline is within 1.5 CSS px except CJK/emoji and tab lines at zoom 0.8 (8 device px = 4 CSS px).

## Pitfalls recorded

- `UNPACK_FLIP_Y_WEBGL` flips the whole atlas, not each slot. With row-based
  UVs this scrambles which glyph a slot samples. Keep upload flipping false
  and keep the top-down slot UVs.
- `getScrolledVisiblePosition()` can return null or degenerate identical
  positions while the Monaco host is `display:none`. Layout probes force the
  host visible and call `editor.render(true)` before reading positions.
- Monaco 0.57 `FontInfo` has no usable ascent/descent fields. The advance comes
  from `FontInfo`; baseline placement comes from the DOM probe, with the
  Canvas2D font-metrics formula only as fallback.

## Verdict

The metric-alignment approach is viable: with Monaco's own advance, a DOM-probed baseline and per-code-point prefix sums, the GPU frame matches Monaco within ~1.5 CSS px horizontally at all four zooms (checked by the lead on the captures); the baseline gap at zoom 0.8 for wide-glyph and tab lines (4 CSS px) is the one alignment item left for the product (LineLayout, D4/D9).

**Stop-point candidate (AGENTS.md "Monaco on its own exceeds the task budget")**: every action has 1–2 main-thread tasks between 9.9 and 11.8 ms (earlier runs up to 21.5 ms) and 1–2 dropped frames, and input-to-next-paint is 32–40 ms. This spike cannot attribute those tasks to Monaco versus its own harness; the human decides whether to accept it for now and let the performance harness (tasks 4.x, 11.8) measure Monaco in the product, or to investigate further first.

## Design impact

- D4 `LineLayout`: retain a fractional advance per code point and derive glyph
  x positions from prefix sums; integer cell counts are insufficient for the
  fallback-font widths observed here.
- D6 glyph atlas: rebuild only when zoom changes, size slots to measured
  advances, preserve R8 alpha semantics, and document colour emoji as
  silhouettes.
- D9 metric alignment: source the narrow advance from Monaco's current
  `FontInfo`, source wide-glyph widths from Monaco position probes, and use the
  same layout projection for GPU rendering and swap comparison.

## Open questions and lead checks

- Re-run the headed harness and inspect `zoom-1-before.png` against `after` at
  every zoom; confirm upright text, matching token colours, gutter, and no
  clipping.
- Confirm the tabs sample logs the original text plus WebGL and Monaco x
  positions and Δx for its first 40 source columns.
- Confirm `latest.json` contains non-zero per-category column measurements and
  that the final CJK/emoji and tabs deviations are acceptable at each zoom.
- Decide whether the product needs a checked-in monospace font for deterministic
  fallback-font advances, and whether colour emoji require a future RGBA atlas.

## Offline verification

- `pnpm validate` — exit 0; typecheck, lint, max-lines, formatting, knip, and
  the repository's 3 test files / 20 tests passed.
- Production Vite build of `spikes/c` — exit 0.
- Headed browser measurement is lead-owned; this agent did not launch Chrome.
