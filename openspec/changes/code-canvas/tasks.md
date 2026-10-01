## 1. Scaffolding and quality gates

- [x] 1.1 Initialize git, pnpm, Vite + TypeScript (vanilla), `.gitignore`, `.nvmrc`; `pnpm dev` opens an empty page
- [x] 1.2 `tsconfig` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noImplicitOverride`; a `typecheck` script
- [x] 1.3 ESLint flat config: `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked`, `max-lines: 800` (blank lines and comments count), `max-lines-per-function: 80`, `complexity: 15`, `max-depth: 4`, `max-params: 4`, `import-x/no-cycle`, `no-restricted-properties` for `innerHTML`/`outerHTML` in `src/`
- [x] 1.4 `eslint-plugin-boundaries` with the element types and dependency rules from design D3; `no-restricted-imports` for `monaco-editor`/`twgl.js` outside the allowed directories; `no-restricted-globals` for DOM in `*/domain/**`; for each rule — a violation fixture in the lint-config test proving the rule fires
- [x] 1.5 A `check-max-lines` script for `.glsl`/`.css` (≤ 800 lines), Prettier (`format`, `format:check`), `knip`
- [x] 1.6 Vitest (unit) and Playwright (e2e) with one trivial test each; the test runs report a non-zero number of cases
- [x] 1.7 An aggregating `pnpm check` command (typecheck, lint, max-lines, format:check, knip, unit); a pre-commit hook on changed files; the hook rejects a commit that changes `perf/baseline.json` without a human-confirmation marker; GitHub Actions: `pnpm check` + e2e
- [x] 1.8 The directory scaffolding from design D11 with `index.ts` for every context; `pnpm check` green
- [x] 1.9 Reference Dataset generator `fixtures/`: deterministically 200 TS/TSX files of 2000 lines each, dense tokens, lines up to 300 characters, JSX, template strings, multiline comments, tabs, non-ASCII characters; re-running it gives an identical result
- [x] 1.10 Module Map (design D3, D10): one table declares modules, layers, public entries, allowed edges and library areas; the boundaries elements/policies, restricted-import areas and knip entries are generated from it; technical modules have no public entry for other modules (only `app` imports them); the rules give the same result from any working directory; one 800-line constant; a matrix test over a mirror tree with real `src/...` paths covers every allowed and forbidden edge, and no allowed case passes because a file is unknown to the plugin
- [x] 1.11 Reference Dataset as a module (design D11): an in-memory generator with a declared feature profile, a thin CLI that writes it to disk; determinism (generate twice, compare bytes) and the feature profile checked by a Vitest test inside `pnpm check`, replacing string-matching re-detection in `fixtures/verify.ts`; the Edge-case Corpus (CRLF, CR, BOM, blank lines, empty file, trailing whitespace, lines > 300 characters, wide characters, tabs at every column) generated the same way

## 2. Spikes (retire risks before main development; each one gets a report in `docs/spikes/<letter>.md` with numbers and a verdict)

- [ ] 2.1 Spike A: a page with an rAF interval log in Chrome on the reference MacBook — before and after window resize/fullscreen, with and without Low Power Mode, plus a DevTools trace; verdict: is 120 Hz attainable or is a trigger/criterion revision needed. Measure the noise floor of an empty page under trace recording (dropped, partially presented, intervals > 12.5 ms per minute). For the harness: does Chrome launch in a visible window from Playwright (and from the agent sandbox), which DOM events and which inertia phase do CDP `Input.synthesizeScrollGesture`/`synthesizePinchGesture` produce on macOS compared to a recorded real-trackpad event stream, does the frame count from the `@paulirish/trace_engine` engine match the DevTools panel on the same trace, how to attribute main-thread tasks to the application
- [x] 2.2 (withdrawn — answered by spikes C and E, see `docs/spikes/b.md`) Spike B: a WebGL2 alpha-only glyph atlas + instancing on real Reference Dataset text (not identical quads): the instance record with the atlas slot index, tabs, punctuation, JSX, non-ASCII; 50k/100k/200k glyphs, one draw call; measure CPU and GPU frame time while panning; cross-check glyph positions against Monaco
- [x] 2.3 Spike G: text sharpness at fractional zoom (0.4–4.0) — a discrete-size atlas vs. MSDF; 1:1 screenshots at DPR 2, frame time and frames during an atlas size change mid-zoom; a verdict on the approach and the set of raster sizes
- [x] 2.4 Spike C: entering and exiting Monaco editing over the WebGL canvas — a pixel-by-pixel comparison of frames before and after the swap (glyph columns, baseline, scroll position), scale snapping to a whole `lineHeight` (design D9), a pixel tolerance; a trace of typing, pasting 500 lines, undo, and model switching in a 2000-line file with Monaco's minimal configuration — task durations
- [x] 2.5 Spike D: Monarch TypeScript tokenization in a Web Worker without Monaco's DOM part; time for a 2000-line file and for the whole Reference Dataset; byte-for-byte match of token colors with Monaco on the same theme; building the R8 minimap in the worker and its size; verdict: does it work in a worker (if not — a stop point, design D7)
- [x] 2.6 Spike E: the worst-case density of Text + zoom crossing a Detail Level threshold with an instant switch and hysteresis, overlapping widgets in the transition band; a trace; preliminary thresholds and minimap texture width; minimap atlas memory on the Reference Dataset
- [ ] 2.7 Spike F: File System Access — open a folder with 200 files, write an edit with re-reading and hashing before the write, restore the handle from IndexedDB after a reload, persistent-permission behavior
- [x] 2.9 Spike D2: TextMate TypeScript/TSX tokenization (`vscode-textmate` + `vscode-oniguruma` WASM) in a Web Worker (design D7) — WASM and grammar loading in the worker in Vite dev and production builds; time for a 2000-line file and for the whole Reference Dataset; packed token-run output (D4) and its size; the same grammar and theme driving Monaco through a custom tokens provider with byte-for-byte colour parity against the worker on the whole dataset; JSX tags and function identifiers get distinct colours; R8 minimap built in the worker
- [x] 2.10 The root `vite.config.ts` imports no spike (design D11): spike D's worker shim plugin moves into spike D's own Vite config; spikes D and D2 still build and run
- [x] 2.8 Fold the spike verdicts into design.md (update D6/D7/D9, thresholds, and Open Questions) and the noise-floor threshold into `perf/ENVIRONMENT.md`; if a verdict changes the approach or the criterion — stop and confirm with the user

## 3. Vertical slice (by day 3–5; in the target directory structure, with minimal implementations)

- [x] 3.1 One real file from the folder → tokens from the worker → one widget in GPU text with highlighting; camera pan and zoom; switching Detail Level to Minimap
- [x] 3.2 Double click → Monaco over the widget, typing, exit via Escape and via panning; GPU↔Monaco swap within a single frame, new text immediately, highlighting ≤ 100 ms; the GPU view and Monaco take metrics from one Text Metrics module (design D6), proven by the conformance test (every glyph's x within zoom × n/128 + 0.05 CSS px of Monaco's DOM, n = token spans before the glyph, and the baseline within 0.5 CSS px, on the Edge-case Corpus and a Reference Dataset file, at zoom 1 and non-integer zooms 0.8, 1.37, 2)
- [ ] 3.3 A DevTools trace of the slice on the reference machine with real gestures, and a report `docs/spikes/slice.md`; if the slice doesn't hold the budget on a single widget — a stop point with the user

## 4. Performance harness (spec `performance-harness`, design D13)

- [x] 4.1 Document the reference environment in `perf/ENVIRONMENT.md` (machine, Chrome version, display refresh rate, launch conditions, a clean Chrome profile with no extensions, Low Power Mode off, the noise-floor threshold, the date it was agreed on)
- [x] 4.2 `FrameStats` in `src/performance` (a ring buffer of intervals, p50/p95/p99, per-frame-stage time), fed only by the FrameLoop's Frame Sample from `shared/frame` (design D8, D13), with one frame-statistics module (nearest-rank percentile, long-interval count, "unavailable" for an empty sample) shared by the overlay and the harness through the bridge, and the bridge type `src/performance/bridge.ts`; the `window.__perf` bridge and the File System Access mock only in the build with `VITE_PERF_HARNESS=1`; a test builds the regular bundle and checks for the absence of the bridge strings and mock adapters
- [x] 4.3 A boundaries rule: `perf/` imports from `src/` only `src/performance/bridge.ts`; a violation fixture in the lint-config test
- [ ] 4.4 The harness CLI (`pnpm perf`, `pnpm perf:quick`, `pnpm perf:stages`, `--scenario`, `pnpm perf:self-test`, `pnpm perf:baseline` with interactive TTY confirmation) with exit codes 0/1/2/3
- [ ] 4.5 Preflight: headless, browser flags, idle rate ≥ 115 Hz, power on AC, measuring the noise floor and its threshold; environment parameters go into the report; tests for every failure condition
- [x] 4.6 The gesture driver per spike A's verdict (CDP synthesize*Gesture or `dispatchMouseEvent`/`dispatchKeyEvent`; a third option — replaying a recorded real-trackpad event stream), continuous gestures at least as often as the frame rate, typing at the scenario's pace; a zod scenario schema; a test for determinism of the event sequence
- [x] 4.7 Trace recording and frame classification (the DevTools engine or a homegrown parser, per spike A's verdict) — one classifier in `perf/harness/trace.ts` seeded from `spikes/c/trace-analysis.mjs` (`PipelineReporter` state, categories including `cc`, zero frames or tasks = invalid measurement; design D13); metrics: frame statuses, p50/p95/p99/max interval, the count of intervals > 12.5 ms, the longest application task and, separately, browser task (attribution per design D13), GC pauses, frame stages, `DocumentResidency` backlog depth, GPU time or "unavailable"
- [ ] 4.8 Warm-up + repetitions, a verdict based on the worst run, `budgets.json` with thresholds relative to the noise floor, comparison against the baseline, a JSON + Markdown report, traces as `.json.gz` in `perf/results/`
- [ ] 4.9 Stage-timing mode `perf:stages` for the agent: the same scenarios in any Chrome, only stages and application tasks, the report marked "not a frame measurement"
- [ ] 4.10 Coverage check: every `#### Scenario:` of the "Frame budget" and "No background stalls" requirements in the `performance-budget` spec has a matching harness scenario; the run fails on a mismatch
- [x] 4.11 Debug synthetic load via the bridge and `perf:self-test`: a 12 ms main-thread load → the failure is caught; a GPU load exceeding the frame period with a light main thread → the failure is caught; an empty scene → a clean run
- [ ] 4.12 Cross-check: one trace opened in DevTools, the frame count matches the harness report; the result recorded in `perf/ENVIRONMENT.md`
- [ ] 4.13 Process rules in README/AGENTS.md: a task touching rendering, input, the frame cycle, or background work is closed only with a green full `pnpm perf` run and a report path; the agent iterates with `perf:stages`; a full run at least twice a day; a weekly manual trackpad trace (pan, pinch, scroll) in `perf/acceptance/weekly/` compared against the harness; only a human updates the baseline

## 5. Shared kernel

- [ ] 5.1 `shared/geometry`: Vec2, Rect, Mat3 (Board↔screen conversion, zoom to a point) with unit tests
- [ ] 5.2 `shared/domain`: branded Ids, `DomainEvent`, `Result`
- [ ] 5.3 `shared/events`: a typed synchronous event bus with unit tests (subscribe, unsubscribe, delivery order); only for low-frequency events between contexts — per-frame state is pulled (design D5)

## 6. Workspace

- [ ] 6.1 Domain: WorkspaceFolder (`WorkspaceFolderId`), SourceFile, FilePath, Content Version (in-memory counter), FileRevision (content hash), a file filter (`.ts/.tsx`, exclusions for `node_modules`, `.git`, `dist`, `build`, hidden files), SaveConflict; invariant unit tests
- [ ] 6.2 Application layer: `openFolder` (folder identity via `isSameEntry` → `WorkspaceFolderId`), `reopenLastFolder`, `readForEditing` (with conflict detection), `applyDraft` (synchronously bump Content Version and emit `FileContentChanged`, then write asynchronously, re-reading and hashing the file immediately before writing); ports `DirectoryReader`, `FileWriter` (two adapters: File System Access and the harness mock); events `FilesDiscovered(folderId, files)`, `FileContentChanged(fileId, contentVersion, text, lineCount)`; unit tests on fake ports, including an external write between the check and the write
- [ ] 6.3 Infrastructure: File System Access adapters (recursive traversal, UTF-8 decoding with a per-widget error, writing) and an IndexedDB handle store (no port; tested with `fake-indexeddb`)
- [ ] 6.4 Messages (only `textContent`): empty folder, unsupported browser, a "more than 200 files" warning, write error; e2e on the FSA mock

## 7. Board

- [ ] 7.1 Domain: Board, Widget, WidgetFrame (minimum size), StackOrder, ContentScroll (clamping on resize and on line-count change), Camera (zoom to a point, bounds 0.05–4.0), DetailLevel (one per Camera, hysteresis, base line height as configuration), GridLayout, `reconcile(savedLayout, discoveredFiles)`, hit-test (top-most widget, then zone; for the body a body-local point in content coordinates, no line/column — design D4); unit tests per the `canvas-viewport`, `widget-manipulation` and `code-widget-rendering` "Detail levels" spec scenarios
- [ ] 7.2 Application layer: commands pan, zoomAt, fitAll, zoomTo100, moveWidget, resizeWidget, scrollWidget, bringToFront (primitive arguments, no per-input-event allocations); a dirty-widget-id set drained once per frame; `restoreBoard(folderId, discoveredFiles)` on `FilesDiscovered`; line-count updates on `FileContentChanged`; a public `BoardReadModel` (Camera, Detail Level, hit-test, widget rows)
- [ ] 7.3 Layout and camera persistence in IndexedDB with a 1 s debounce, keyed by `WorkspaceFolderId` (no port; tested with `fake-indexeddb`); an autosave unit test on a fake timer; a test that no widget is placed before the saved layout is loaded

## 8. Code View

- [ ] 8.1 Domain: TokenizedDocument (packed `Uint32Array` Token Runs, tied to a Content Version), ThemePalette, LineLayout (design D4: line splitting via the `shared/domain` rule matching Monaco's model — the empty file is one line, a trailing break adds an empty line; code points and surrogate pairs, tab stops, fractional per-code-point advances from a metrics table given at composition with x prefix sums, UTF-16 offset ↔ x, body-local point → line/column, Monaco options derived from it); table-driven unit tests over the Edge-case Corpus `expected` records; the Reference Dataset generator switches to the `shared/domain` rule
- [ ] 8.2 A single theme object in `code-view/infrastructure/theme.ts`, from which both ThemePalette and the Monaco theme are built
- [ ] 8.3 Tokenizer worker-pool adapter (design D7, per spike D2's verdict and the user's pool decision): TextMate grammar + Oniguruma WASM, theme and grammar given at construction, a pool sized from `hardwareConcurrency` with each file pinned to one worker, per-file Content Version + rule-stack cache + resumable ~100-line chunk queue, `contentChanged(fileId, contentVersion, text)` and ranked `wanted(fileId, lineRanges)`, responses `(fileId, contentVersion, line range, Token Runs)` and the R8 minimap when a file completes, token offsets from LineLayout, transferable results; a gate test fails the build when the worker chunk contains a Monaco or CSS module; internal seam `Tokenizer` with two adapters (worker pool, synchronous fake)
- [ ] 8.4 `DocumentResidency` (design D7) as one folder module with one entry point: `contentChanged`, `visibleRangesChanged`, `prioritize`, `drain(budget, uploader)`; ordering priority → visible → rest translated into the Tokenizer's ranked `wanted` line ranges, stale-version drop, single-color state; port `GpuUploader` (cells with palette colour indexes, minimap bytes) with a recording fake; internals tested only through the four methods; unit tests of the whole path text → uploads with no worker and no GL, including a flood of 200 files, a stale response arriving after a newer version, and the Edge-case Corpus
- [ ] 8.5 Showing unhighlighted text until tokens are ready; a test: multiline comments and template strings are highlighted on every line

## 9. Rendering

- [ ] 9.1 GL layer: a single WebGL2 context, programs, buffers (twgl.js), context-loss handling; an e2e test compiles and links all shaders
- [ ] 9.2 The bundled font, metrics, rasterizer, GlyphAtlas (alpha-only `R8`), and the slot table per spike G's verdict; one slot record (raster rect, baseline, UV rect, advance from LineLayout) from which both the rasterizer and the shader's slot table are written, UVs clipped with the glyph, no whole-atlas `UNPACK_FLIP_Y` (design D6); no raster-size changes during an active gesture, neighboring sizes are prepared ahead of time
- [ ] 9.3 WidgetTable (a data texture: Widget Frame, Content Scroll, a unique depth per Stack Order) updated by draining Board's dirty widget ids once per frame; Detail Level as a single uniform
- [ ] 9.4 `GpuUploader` WebGL adapter: line windows (cells + colour indexes) into glyph buffers, with atlas slot assignment and rasterization owned by the adapter; minimap bytes into the minimap atlas; partial buffer and texture updates only
- [ ] 9.5 Background pass: backgrounds, frames, titles, the scroll indicator, depth writing
- [ ] 9.6 Content pass: glyphs when the Detail Level is "Text" (instance: widget, row, x offset from LineLayout, atlas slot, color; a line window around the visible area; clipping against the widget body in the shader) and minimap quads when it is "Minimap" (palette by index, `NEAREST`), depth test `LEQUAL` with no write; line numbers; File Path in the title bar and a large File Path on the minimap
- [ ] 9.7 FrameLoop as a generic Frame Stage runner (design D8): ticks only on dirty state or a gesture, times every stage and emits one Frame Sample per frame; rendering contributes the cull and draw stages (brute-force culling); a unit test with recording fake stages checks the order; fast scrolling draws the loaded window while lines are still being loaded
- [ ] 9.8 e2e screenshot tests: text sharpness at 1.0 scale, widget overlap per Stack Order at both Detail Levels, exactly one kind of content during a transition
- [ ] 9.9 Harness scenarios: pan, zoom across a Detail Level threshold and across an atlas size boundary, worst-case density, maximum-speed scroll, pan during initial load; a green full `pnpm perf`

## 10. Interaction

- [ ] 10.1 `GestureTargeting` (design D8): raw wheel/pointer/key events in, per-frame intents out; target chosen at gesture start from Board hit-test, Detail Level and the active Editing Session, held through the momentum phase; pinch (`ctrlKey`) → zoom to the cursor with `preventDefault`; scroll inside a widget at Text sticks at the content edge; pan at Minimap; wheel over the editor goes to Monaco; pan/zoom while editing ends the session with a pending gesture; drag/resize of the active widget refused
- [ ] 10.2 Pointer intents: pan by dragging empty space and with the spacebar, drag by the title bar, resize from the right/bottom edge and corner with an on-screen grab zone, bringToFront on click
- [ ] 10.3 Keyboard shortcuts Shift+1, Shift+0, the metrics overlay; unit tests of every routing scenario over recorded event sequences, with no browser
- [ ] 10.4 e2e per the `canvas-viewport`, `widget-manipulation` scenarios and the scroll scenario from `code-widget-rendering`
- [ ] 10.5 Harness scenarios: dragging, resizing, scrolling inside a widget; a green full `pnpm perf`

## 11. Editing

- [ ] 11.1 Domain: EditingSession (at most one, a stationary camera and Widget Frame), Draft, AutosavePolicy; unit tests
- [ ] 11.2 `EditingTransition` (design D9): `begin(widgetId, clickPoint)` (re-read the file, conflict, Camera snap), `end(reason, pendingGesture?)` (Escape, click outside, pan, zoom, another widget; `applyDraft`, `DocumentResidency.prioritize`), `takeFrameSwap()` applied atomically by the FrameLoop; a 1 s autosave, write errors with retry; port `EditorHost` with two adapters (Monaco, fake); unit tests of every exit reason with the fake and no WebGL
- [ ] 11.3 Infrastructure: a single Monaco instance in a minimal configuration (design D9), `setModel`, the theme from 8.2, the container is placed on entry, the GPU↔Monaco swap happens within a single frame, new text right after exit with highlighting ≤ 100 ms
- [ ] 11.4 An e2e check that drag and resize of the active widget are refused during editing (the rule itself lives in `GestureTargeting`, 10.1)
- [ ] 11.5 Double-clicking a Minimap zooms in on the widget to 1.0 without entering editing
- [ ] 11.6 Conflict UI: choosing between the on-disk version and one's own
- [ ] 11.7 e2e per the `code-editing` spec scenarios (cursor at the click position, pan and zoom end the session, stationary editor, autosave to disk, highlighting after an edit)
- [ ] 11.8 Harness scenarios: typing, paste, undo, model switching; a green full `pnpm perf`

## 12. Application assembly

- [ ] 12.1 Composition root `app/main.ts`: wire the contexts, the event bus, and the FrameLoop's stage list in the design D8 order (intents → commands → Camera/Detail Level → dirty ids → culling → visible ranges → editing swap → budgeted drain → draw) declared in one place; the regular build doesn't import mock adapters
- [ ] 12.2 Screens outside the canvas: folder picker/reopen, notifications, toolbar ("Fit all", "100%"); a CSP with no third-party sources
- [ ] 12.3 README: requirements (Chrome, macOS ProMotion), running it, the reference environment, how to reproduce the measurement in DevTools, `pnpm perf`, and manual acceptance

## 13. Acceptance

- [ ] 13.1 A manual run of all spec scenarios on the Reference Dataset and on a real repository
- [ ] 13.2 Manual DevTools traces with real gestures for every interaction from the `performance-budget` spec, with a noise-floor measurement from the same session; budget criteria met; traces in `perf/acceptance/`
- [ ] 13.3 `openspec validate code-canvas --strict`, `pnpm check`, and a full `pnpm perf` — all green
