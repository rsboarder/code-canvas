## Context

The repository is empty; motivation and scope are in `proposal.md`, behavior is in `specs/*/spec.md`. The technical foundation is the research doc `docs/research-code-canvas.md` (hereafter "the research"), accepted by the user as the plan with two amendments: spike G was added (text sharpness at fractional zoom), the benchmark runs only on the reference MacBook in a visible Chrome window.

Constraints shaping the design:
- Chrome on macOS, ProMotion 120 Hz; the criterion is DevTools Performance (spec `performance-budget`).
- The code is mostly written by AI agents. The architecture must be machine-checkable: module boundaries, size limits, and cycles are caught by the linter, not by review.
- The approach is DDD, a modular structure, **files no longer than 800 lines** (user's decision).
- Monaco is the only full-featured editor (user's decision); other libraries are allowed.

The domain vocabulary is `CONTEXT.md` at the repository root; the terms below are used in its meanings.

## Goals / Non-Goals

**Goals:**
- A modular monolith of bounded contexts with explicit, linter-checked dependencies.
- A hot frame path (pan/zoom/drag) with no per-widget/per-glyph allocations and no worker calls.
- An architecture where every risky assumption from the research is closed by a spike before main development.
- A set of linters and gates that an agent runs with a single command.

**Non-Goals:**
- Multi-user support, a backend, deployment.
- Languages other than TypeScript/TSX; line wrapping; character widths wider than one cell (CJK, emoji — they are drawn, but alignment is not guaranteed).
- Support for browsers other than Chrome; WebGPU.
- A UI framework (React, etc.): the UI outside the canvas — a handful of panels — is written with the DOM API.

## Decisions

### D1. Modular monolith, bounded contexts

A single application (Vite + TypeScript, one `package.json`), with the code split into contexts. A monorepo with packages was rejected: for a single application it means extra build configs with no payoff, and boundaries are already checked by the linter (D10).

| Context | Type | Responsibility | Main concepts |
|---|---|---|---|
| `workspace` | core | the folder on disk, files, revisions, writing, conflicts | WorkspaceFolder, SourceFile, FilePath, FileRevision, SaveConflict |
| `board` | core | the spatial model of the canvas | Board, Widget, WidgetFrame, StackOrder, ContentScroll, Camera, DetailLevel, GridLayout |
| `code-view` | core | how code looks and gets to the GPU: tokens, palette, line layout, document residency | TokenizedDocument, TokenRun, ThemePalette, LineLayout, DocumentResidency |
| `editing` | core | the editing lifecycle of a single widget | EditingSession, Draft, AutosavePolicy, EditingTransition |
| `rendering` | generic (technical) | GPU mechanics: context, atlas, passes, the frame loop | GlyphAtlas, WidgetTable, GpuUploader adapter, RenderPass, FrameLoop |
| `interaction` | supporting | translating raw input into per-frame intents and context commands | GestureTargeting, Shortcut |
| `performance` | supporting | frame metrics, overlay | FrameStats |
| `app` | composition root | wiring dependencies, screens outside the canvas | — |

`rendering`, `interaction`, and `performance` have no domain layer: they are technical modules and don't need the DDD hierarchy.

### D2. Context map

```
                      low-frequency domain events (bus)
 workspace ──FilesDiscovered(folderId, files)──▶ board (restoreBoard → reconcile)
 workspace ──FileContentChanged(fileId, version, text, lines)──▶ board (content height)
                                                └──────────────▶ code-view (DocumentResidency)
     ▲
     │ readForEditing / applyDraft (application services)
  editing (EditingTransition) ◀── commands ── interaction (GestureTargeting) ── commands ──▶ board

                      per-frame pulls (FrameLoop, no events)
 rendering ──camera, Detail Level, dirty widget ids, hitTest──▶ board
 rendering ──visibleRanges / drain(budget, GpuUploader)──────▶ code-view
 rendering ──takeFrameSwap()─────────────────────────────────▶ editing
```

- **workspace → board**: `FilesDiscovered(folderId, files)` (each file: `SourceFileId` + line count) → board's `restoreBoard` loads the saved layout for `folderId` and reconciles it with the discovered files in one step (D12). Board references files only by `SourceFileId` and folders only by `WorkspaceFolderId`; it never sees file-system handles.
- **workspace → board, code-view**: `FileContentChanged(fileId, contentVersion, text, lineCount)` on every new Content Version — a read from disk or an applied Draft. This is the only path by which text reaches `code-view`: `DocumentResidency` takes the text; board updates the widget's content height and re-clamps its Content Scroll.
- **Content Version vs File Revision**: Content Version is an in-memory counter per Source File, bumped synchronously on every text change; it keys tokenization and GPU data. File Revision is the content hash of what is on disk; it guards writes against conflicts (D12). Keeping them apart lets a Draft reach the screen in the same frame while the hash and the write stay asynchronous.
- **editing ↔ workspace**: editing calls workspace's application services `readForEditing` (with conflict detection) and `applyDraft(fileId, text)`. `applyDraft` synchronously bumps the Content Version and emits `FileContentChanged`, then schedules the asynchronous write. Conflict is a workspace concept.
- **Exiting with edits**: the `EditingTransition` module (D9) applies the Draft, marks the file as a priority in `DocumentResidency`, and hands the FrameLoop one swap record; in that tick Monaco is hidden and the widget's visible line window is uploaded unhighlighted (single color); highlighting arrives from the worker within 100 ms (spec `code-editing` "Exiting editing"). Keeping Monaco visible until the tokens are ready was rejected: it leaves a scalable DOM editor in the middle of a gesture and creates uncertainty on timeout.
- **interaction → board/editing**: only application-layer commands, produced from per-frame intents of `GestureTargeting` (D8); no direct mutation of domain objects.
- **rendering**: pulls what it needs once per frame through the contexts' public `index.ts` (D5); it subscribes to no domain events and writes nothing to the domain.

The event bus is synchronous, in-process, and typed (`shared/events`), and carries only low-frequency events between contexts (folder opened, content changed, editing started/ended). Per-frame state is pulled, never pushed through the bus. Asynchrony exists only at infrastructure boundaries (the tokenization worker, File System Access, IndexedDB).

### D3. Layers inside a core context

```
<context>/
  domain/          pure TS: entities, value objects, aggregates, domain events, policies. No DOM, WebGL, Monaco, async I/O.
  application/     use cases (commands/queries), ports (interfaces) to infrastructure, subscribers to other contexts' events.
  infrastructure/  port adapters: File System Access, IndexedDB, Web Worker, Monaco.
  index.ts         the context's public API: commands, read model, event types. The only entry point from outside.
```

Dependency rules (checked by the linter, D10):
- `domain` → only `shared/domain`, `shared/geometry`.
- `application` → its own `domain`, `shared`, other contexts' public `index.ts`.
- `infrastructure` → its own `application`/`domain`, `shared`, external libraries.
- Importing another context is only through its `index.ts`; deep imports are forbidden.
- Any context's infrastructure is imported only by `app` (composition root).
- `monaco-editor` — only in `editing/infrastructure` and `code-view/infrastructure`; `twgl.js` and WebGL — only in `rendering`.
- Cycles between modules are forbidden.

### D4. Aggregates and invariants

- **Board** (the root) with **Widget** entities. Invariants: one widget per `SourceFileId`; `WidgetFrame` is never smaller than the minimum; `StackOrder` is a strict order with no duplicates; `ContentScroll` stays within `[0, contentHeight − viewportHeight]`, recomputed on resize and whenever the line count changes. **Camera** is a value object inside Board: scale in `[0.05, 4.0]`, zooming toward a point keeps that point under the cursor. `GridLayout` is the domain policy for the initial layout; `reconcile(savedLayout, discoveredFiles)` is a pure policy that keeps saved widgets, drops missing files, and places new files to the right of the grid.
- **DetailLevel** lives in Board next to Camera. The on-screen line height (`lineHeight × zoom × DPR`) is the same for every widget, so there is one Detail Level per Camera, not per widget. Board stores the current level and applies hysteresis (different thresholds for zooming out and zooming in) whenever the Camera changes; the base line height is configuration given at composition from `code-view`'s LineLayout. `rendering`, `interaction` and the metrics overlay only read it. Numeric thresholds are set after spikes E/G.
- **Hit-test** is a pure query on Board: top-most widget under a screen point, then the zone (header, edge, body with line/column, empty canvas). It uses the same Widget Frames, Stack Order and Camera as rendering.
- **WorkspaceFolder** (identified by `WorkspaceFolderId`) with **SourceFile** entities (path, Content Version, File Revision = hash of the on-disk content; `lastModified` and size are only a quick change indicator). Invariants: a file filter (`.ts/.tsx`, directory exclusions); a write is allowed only from a known File Revision, otherwise — `SaveConflict`.
- **EditingSession**: states `Idle | Editing(widgetId, draft, dirty)`; at most one active session — an aggregate invariant, not a UI convention. `AutosavePolicy` — 1 s after the last edit, and on exit.
- **TokenizedDocument** (`code-view`): immutable, tied to `(fileId, contentVersion)`; stores lines as packed `Uint32Array` token runs (offset + palette color index), as in Monaco.

### D5. Hot path: DDD does not participate in per-frame work

Tension: DDD objects with invariants are convenient for commands, but the 120 Hz hot loop must not go through them for every widget. The solution is **CQRS-lite**:
- Commands (pan, drag, resize, scroll) go through the application layer and the domain with primitive arguments: O(1) work per input intent, no event objects.
- Board records which widgets changed in a dirty set. Once per frame, at the camera stage, `rendering` drains the dirty ids and copies those widgets into its own projection in typed arrays (`WidgetTable`: position, size, scroll, depth) — one table row per changed widget. Update ordering is therefore the FrameLoop's tick order (D8), not event delivery order.
- A frame reads only the projections, the Camera and the Detail Level. Rule for `rendering/` and `interaction/`: per-frame code has no per-widget/per-glyph allocations (a review checklist + the harness catches GC pauses).

Rejected: "rendering reads domain objects directly" — couples the domain to the GPU data format and invites allocations in the loop; "rendering subscribes to hot-path domain events" — every pan or drag would pass command → domain → bus → subscriber, with reused event objects that a subscriber can accidentally retain and an unwritten ordering between bus delivery and the tick.

### D6. Rendering (WebGL2)

- **A single WebGL2 context** for the whole application, on the main thread (research, items 2/5). OffscreenCanvas/Worker was rejected: swapping the GPU representation for Monaco and back must happen within a single frame together with the DOM, and cross-thread synchronization via `postMessage` doesn't guarantee that. The camera is stationary while editing (spec `code-editing` "Stationary editor"), so there's no need for frame-by-frame synchronization of Monaco with panning.
- **Raw WebGL2 + twgl.js** (research, Tradeoff Matrix). Fallback path — PixiJS v8 with a custom Mesh, if spike B shows that a homegrown renderer won't fit the schedule.
- **Glyph atlas**: an alpha-only `R8` texture, glyphs are rasterized via `OffscreenCanvas` 2D with a monospace font shipped in the bundle (one woff2, the same one used by Monaco). Color is an instance attribute, not part of the atlas (xterm.js anti-pattern #6074).
- **Sharpness at fractional zoom** — resolved by spike G. Candidates: (a) an atlas over a set of discrete raster sizes, picking the nearest size that's not smaller, switching with a debounce after the gesture ends; (b) MSDF. The default before the spike is (a), because bitmap hinting is better for small monospace point sizes.
- **Glyph instance** — a fixed-size record: widget index, row, column, atlas slot index (slot → UV and atlas page via a slot table in a uniform/data texture), palette color index. There are no world coordinates in the instance. Text is a sequence of Unicode code points (surrogate pairs are combined), tabs are expanded to spaces per LineLayout, ligatures are disabled, a character outside the font is drawn with a one-cell placeholder slot. Widget position, size, and scroll are taken by the shader from `WidgetTable` (a data texture). Result: drag/resize/scroll within the line window update one table row, not the glyph buffers.
- **Line window**: a widget's glyph buffer holds the visible lines plus one screen's worth of margin above and below; when scroll moves outside the window, `DocumentResidency` rebuilds it within its drain budget (D7, D8). We don't keep all 2000 lines × 200 files on the GPU.
- **Per-widget clipping** — in the fragment shader, against the widget body rectangle from `WidgetTable` (one draw call for all widgets, no per-widget scissor).
- **Stacking order via the depth buffer**: each widget gets a unique depth from `StackOrder`. Pass 1 — opaque widget backgrounds/frames, writing depth; pass 2 — content: glyphs when the Detail Level is "Text", minimap quads when it is "Minimap", depth test `LEQUAL` with no write. This way the content of a widget below doesn't show through the background of one above; since all widgets share one Detail Level, each frame draws exactly one kind of content. Translucent backgrounds, shadows, and rounded corners with cutouts are not supported by this scheme.
- **Minimap** (Detail Level "Minimap"): the strip image is built on the CPU in the tokenization worker right after tokenization — a `Uint8Array` of palette indices (R8, 0 = background), one texel row per line of code, fixed width (the value is set after spike E), bounded height (long files are decimated). The texture is transferred to the main thread as a transferable and loaded into a shared minimap texture atlas through `DocumentResidency`'s budgeted drain (D7); color is looked up in the shader from the palette, `NEAREST` filtering by index, no mipmaps (averaging indices is meaningless). At far zoom, a widget is a single quad sampling the file's visible slice. A naive RGBA-with-mipmaps variant was rejected: on the order of hundreds of MB for 200×2000 lines (a design-review estimate, not a measurement); "a rectangle per token run" was rejected: up to ~1M instances.
- The **file name** is drawn in a large font by the same glyph pass, from the large-size atlas.
- **Detail Level transition** — an instant switch of the single Detail Level within one frame, with hysteresis; both representations are ready ahead of time (research risk #5). A crossfade was rejected: with overlapping widgets in the transition band, blending two translucent representations breaks the stacking order, and the spec only requires the absence of empty frames.
- **Draw calls per frame**: 3–5. Culling — brute-force iteration over 200 AABBs, no spatial index.

### D7. Tokenization

- There is a single source of color: the theme object, from which both `monaco.editor.defineTheme` and `ThemePalette` (`code-view/infrastructure/theme.ts`) are built — color matching by construction.
- The tokenizer is Monaco's Monarch TypeScript grammar in a Web Worker, without Monaco's DOM part. There is no tokenization on the main thread: that would contradict spec `performance-budget` "No background stalls". If spike D shows that Monarch doesn't build in a worker, that's a stop point: go back to the user with alternatives (a different tokenizer in the worker, mapped onto the Monaco theme). The `Tokenizer` port in `code-view/application` hides the implementation.
- **DocumentResidency** (`code-view/application`) owns each Source File's path from text to GPU-ready data: text, Content Version, tokens, minimap bytes, the visible line range, and whether it is still unhighlighted. Its interface is small: `contentChanged(fileId, version, text)`, `visibleRangesChanged(ranges)` (from the FrameLoop after culling), `prioritize(fileId)` (from `EditingTransition`), and `drain(budget, uploader)`. Ordering (priority, then visible, then the rest), staleness and the single-color fallback live only here.
- Internal seam `Tokenizer`: the Web Worker adapter in production, a synchronous in-process fake in tests (two adapters). Every worker request and response carries `(fileId, contentVersion)`; a stale response is dropped inside `DocumentResidency`, before anything is queued for the GPU. Jobs for files that are no longer visible and already stale are cancelled. Results (`Uint32Array` of tokens, `Uint8Array` of minimap data) are transferred as transferables, without copying.
- External seam `GpuUploader`, declared in `code-view/application`: `rendering` implements it with WebGL (line windows into glyph buffers with atlas slots, minimap bytes into the minimap atlas); tests use a recording fake. The whole path "text changed → uploads issued" is therefore testable with no worker and no GL.
- `drain` serves a prioritized file's visible line window regardless of the budget (bounded to one widget's window); everything else stays within the budget.
- Until tokens are available, the widget is drawn in a single color (spec `code-widget-rendering`).

### D8. Frame cycle and work budget

- A single `FrameLoop` (rendering) driven by `requestAnimationFrame`, running only while there are "dirty" changes or a gesture is in progress; it does not spin at rest.
- Tick order: `GestureTargeting` turns accumulated input into intents → commands to board/editing → Camera and Detail Level → drain Board's dirty widget ids into `WidgetTable` → culling → `DocumentResidency.visibleRangesChanged` → apply `EditingTransition.takeFrameSwap()` (Monaco container, widget visibility, priority file) and replay the pending gesture → `DocumentResidency.drain(budget, uploader)` (default 2 ms; line windows, tokens, minimaps, atlas slots; the remainder carries over, priority then visible first) → draw.
- The same-frame swap on exiting editing and the budgeted drain do not conflict: the swap record and the prioritized window are the only work allowed outside the budget, and both are bounded to one widget.
- Fast scrolling inside a widget: the line window has margin, and if the rebuild didn't finish in time, the frame draws the already-loaded window, missing lines are loaded in subsequent frames; the harness includes a maximum-speed scroll scenario with a queue-depth metric.
- The hot input path has no per-event allocations: intents and commands take primitives, and there are no hot-path domain events (D5).
- Input: `wheel` on the canvas, non-passive, with `preventDefault` (pinch = `wheel` + `ctrlKey`); pointer events with `setPointerCapture`. Events accumulate and are applied once per frame.
- **GestureTargeting** (`interaction`) is the one module that decides what a gesture does. It picks the target when a gesture starts, using Board's hit-test, the Detail Level and whether an Editing Session is active, and keeps that target until the gesture ends, including the OS momentum phase: a scroll that reaches a widget's content edge stays on that widget; wheel over the editor goes to Monaco; pan or zoom on the canvas while editing ends the session and carries on as a pending gesture; drag and resize of the active widget are refused. Its interface is raw events in, per-frame intents out, so every routing scenario in the specs is a unit test over a recorded event sequence, with no browser.

### D9. Monaco

- One instance per application, files are switched with `setModel()`; models are created on entering editing and disposed on exit (we don't keep 200 models).
- The DOM container over the canvas is placed once on entering editing; the camera and the active widget's geometry stay stationary until exit (spec `code-editing` "Stationary editor"). Wheel input over the container is handled by Monaco; any other input on the canvas ends the session.
- Monaco's configuration is minimal: no minimap, overview ruler, word wrap, code lens, diagnostics, or semantic tokens.
- **Metric alignment**: Monaco receives `fontSize`/`lineHeight` = base values × zoom. Monaco rounds `lineHeight` to whole pixels, while the GPU layout is fractional. Solution: on entering editing, the camera is snapped to the nearest scale where `lineHeight × zoom` is a whole number of CSS pixels (shift ≤ a few percent, toward the click point). The horizontal step (`charWidth × zoom`) is also fractional — spike C compares the frame before and after entry pixel by pixel (glyph columns, baseline, scroll position) and determines the tolerance.
- **EditingTransition** (`editing/application`) owns the whole enter/exit sequence, so the "one frame" invariant lives in one module. `begin(widgetId, clickPoint)`: `readForEditing` with conflict check, Camera snap, Monaco model and placement through the `EditorHost` port. `end(reason, pendingGesture?)`: `applyDraft` if there are edits, `DocumentResidency.prioritize`, model disposal. `takeFrameSwap()`: one record the FrameLoop applies atomically in a single tick — hide or show the widget's GPU representation, place or remove the Monaco container, the pending gesture to replay. `EditorHost` has two adapters: Monaco in production, a fake in tests, so every exit reason in the spec (Escape, click outside, pan, pinch, double click on another widget) is tested without Monaco or WebGL.

### D10. Linting and quality gates

A single `pnpm check` command (the agent must run it before committing; the pre-commit hook repeats it on changed files):

| Check | Tool | What it catches |
|---|---|---|
| Types | `tsc --noEmit`, `strict` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noImplicitOverride` | type errors |
| Lint | ESLint flat config + `typescript-eslint` `strictTypeChecked` and `stylisticTypeChecked` | unsafe TS, floating promises |
| File size | ESLint `max-lines: 800` (blank lines and comments count) + a `check-max-lines` script for non-TS sources (`.glsl`, `.css`) | the "≤ 800 lines" requirement |
| Function size/complexity | `max-lines-per-function: 80`, `complexity: 15`, `max-depth: 4`, `max-params: 4` | code bloat from agents |
| Architectural boundaries | `eslint-plugin-boundaries`: element types `domain/application/infrastructure/index/shared/app/rendering/interaction/performance`, D3 rules | layer violations and deep imports |
| Library restriction | `no-restricted-imports`: `monaco-editor`, `twgl.js` outside allowed directories; DOM globals in `domain` (via `no-restricted-globals`) | infrastructure leaking into the domain |
| Cycles | `import-x/no-cycle` | circular dependencies |
| Dead code | `knip` | unused files, exports, dependencies |
| Format | Prettier (`--check`) | style |
| Tests | Vitest (domain and application layer), Playwright (functional e2e, compiling all shaders) | behavior regressions |

CI (GitHub Actions) runs `pnpm check` and the functional e2e tests. The performance harness does not run in cloud CI: headless Chrome isn't tied to 120 Hz vsync — it is run via `pnpm perf` on the reference machine in a visible window (D13).

### D11. Directory structure

```
CONTEXT.md                     the domain vocabulary
src/
  shared/
    geometry/                  Vec2, Rect, Mat3 — pure math
    domain/                    Id types, DomainEvent, Result
    events/                    the typed synchronous bus
  workspace/  {domain,application,infrastructure,index.ts}
  board/      {domain,application,infrastructure,index.ts}
  code-view/  {domain,application,infrastructure,index.ts}   application: DocumentResidency; infrastructure: tokenizer.worker.ts, theme.ts
  editing/    {domain,application,infrastructure,index.ts}   application: EditingTransition; infrastructure: monaco-editor-host.ts
  rendering/
    gl/                        context, programs, buffers
    text/                      font, metrics, rasterizer, GlyphAtlas
    scene/                     WidgetTable, GpuUploader adapter (glyph buffers, minimap atlas)
    passes/                    background, glyph, minimap
    shaders/                   *.glsl
    frame-loop.ts, index.ts
  interaction/                 GestureTargeting, shortcuts
  performance/                 FrameStats, overlay
  app/                         main.ts (composition root), screens: folder picker, notifications, toolbar
perf/                          the performance harness (D13)
fixtures/                      generator for the 200-file reference dataset
tests/e2e/                     functional Playwright scenarios
spikes/<letter>/               throwaway spike pages (group 2), one Vite entry each
```

Spike code in `spikes/` is research, not product: it is typechecked and formatted, but excluded from the boundaries, max-lines/complexity and knip rules, and nothing in `src/` or `perf/` imports it. Reusable findings move into `src/` through regular tasks, never by importing a spike.

### D12. Storage

- The folder handle is stored in IndexedDB; on startup, `queryPermission`, and if needed, `requestPermission` on click (Chrome 122+ offers a persistent permission).
- Folder identity is a workspace concern: workspace matches a newly picked handle against saved handles with `isSameEntry` and assigns a stable `WorkspaceFolderId`.
- Layout (Board: widgets + camera) is stored in IndexedDB keyed by `WorkspaceFolderId`, debounced 1 s. Restoring is one step: `restoreBoard(folderId, discoveredFiles)` loads the saved layout and runs the pure `reconcile` policy (D4), so no widget is placed before the layout is known. Rejected: a `.code-canvas.json` file in the folder — that writes into someone else's repository.
- Seams only where two adapters exist: `DirectoryReader`/`FileWriter` (File System Access + the harness mock), `Tokenizer` (worker + sync fake), `EditorHost` (Monaco + fake), `GpuUploader` (WebGL + recording fake). The IndexedDB stores for the folder handle and the layout have one production adapter each; they are tested against an in-memory IndexedDB (`fake-indexeddb`) rather than behind a port.
- Writing a file: immediately before the write, the file is re-read and hashed; if the hash doesn't match the known File Revision → `SaveConflict` (spec `workspace-storage`). `lastModified` + size are used only to avoid re-reading files when scanning the folder.

### D14. Security

- File paths and names are rendered to the DOM only via `textContent`; `innerHTML` in `src/` is forbidden by the linter (`no-restricted-properties`).
- The `window.__perf` bridge and the File System Access mock exist only in the build with `VITE_PERF_HARNESS=1`; a test builds the regular bundle and verifies the absence of the bridge strings and mock adapters; the regular build's composition root does not import the mock.
- The font comes only from the bundle; there are no external downloads; the page's CSP forbids third-party script and font sources.
- The worker receives only the file's text; the grammar and theme are static, nothing from file content is ever executed.

### D13. Performance harness (`perf/`)

A separate Node tool in the same repository (spec `performance-harness`). It is built right after the spikes and before the main features, so that every rendering task is checked by it from day one.

```
perf/
  harness/
    cli.ts            commands: run [--quick] [--scenario <name>], self-test, baseline:update
    preflight.ts      environment validity
    driver.ts         feeding gestures through CDP
    trace.ts          trace recording and frame parsing
    metrics.ts        collecting app metrics through the bridge
    report.ts         JSON + Markdown, comparison with the baseline
    coverage.ts       matching scenarios against the performance-budget spec
  scenarios/          declarative scenarios (*.ts, schema validated with zod)
  budgets.json        thresholds and allowed deviations from the baseline
  baseline.json       the baseline (committed)
  acceptance/         manual acceptance traces (committed, .json.gz)
  results/            run artifacts (in .gitignore)
```

- **Browser launch**: Playwright + system Chrome stable (`channel: 'chrome'`), a visible window covering the whole built-in display, no flags touching vsync/frame rate.
- **Preflight**: headless detection (`navigator.webdriver` is not enough — user agent and CDP `Browser.getVersion` are checked), flags from CDP `Browser.getBrowserCommandLine`, idle rate — 2 s of rAF intervals on an empty page (threshold ≥ 115 Hz), power — `pmset -g batt`. Machine model, display refresh rate, DPR — go into the report.
- **Feeding gestures**: preferably CDP `Input.synthesizeScrollGesture` / `Input.synthesizePinchGesture` — they go through the browser's input and compositor pipeline, like a real trackpad; for drag/resize — `Input.dispatchMouseEvent`, for typing — `Input.dispatchKeyEvent`. Which CDP gestures produce, on macOS, the same DOM events as a trackpad (pinch → `wheel` + `ctrlKey`) is checked in spike A; the fallback is `Input.dispatchMouseEvent` of type `mouseWheel` with the Ctrl modifier, paced by a high-resolution Node timer.
- **Frame classification**: a CDP `Tracing` trace with DevTools timeline categories; parsing uses the same trace engine as the DevTools Performance panel, published as an npm package (`@paulirish/trace_engine`; its availability and API are checked in spike A). If it can't be used — a homegrown parser of frame events, cross-checked against the DevTools panel on the same trace (the spec's "Artifacts" requirement).
- **App bridge**: a build with the `VITE_PERF_HARNESS=1` flag exposes `window.__perf` — `FrameStats` by stage, GPU time via `EXT_disjoint_timer_query_webgl2` (if available), synthetic-load control for the self-test, state-preparation commands (open the reference dataset without a dialog via the File System Access mock, set the camera). In a regular build the bridge is stripped at build time. The bridge type is the single file imported by both the application (`src/performance/bridge.ts`) and the harness; the rest of `src/` is off-limits to the harness (the boundaries rule).
- **Noise floor**: before the scenarios — a run of an empty page with an rAF loop of the same duration and the same set of trace categories; the result goes into the report and into the comparison against thresholds (spec `performance-budget` "Noise floor").
- **Task attribution**: a main-thread task is counted as an application task if its stack contains code from the app bundle (including Monaco) or it was spawned by the app's event handlers, timers, rAF, or worker messages; everything else is a browser task.
- **Repetitions**: 1 warm-up run + 5 measured runs by default (`budgets.json`), verdict based on the worst one.
- **Coverage**: `coverage.ts` reads the `#### Scenario:` headings of the "Frame budget" and "No background stalls" requirements from `openspec/specs/performance-budget/spec.md` (before the change is archived — from `openspec/changes/code-canvas/specs/`) and requires a scenario with the same name.
- **Output for agents**: stdout carries the verdict and a table (scenario × key metrics × delta to the baseline); everything else goes into `perf/results/<time>/`. Exit codes: 0 — passed, 1 — budget violation or regression, 2 — the measurement is invalid (preflight).
- `FrameStats` is the shared source for the metrics overlay and the harness.
- **Stage-timing mode** (`pnpm perf:stages`): the same scenarios in any Chrome, including headless, only frame stages and application tasks, exit code 3 for "not a frame measurement" — for agent iteration.
- **Baseline**: `pnpm perf:baseline` requires interactive confirmation in a TTY; without a TTY — an error, no changes.
- Running from an agent sandbox may fail to open a visible Chrome window; in that case the user runs the full run (`! pnpm perf`) and hands the agent the report path.

## Risks / Trade-offs

- Chrome/macOS stays at 60 Hz without a trigger (research, risk #1, T3 single) → spike A on day one; if confirmed — a programmatic trigger (fullscreen/resize) and a description in the reference environment; if unattainable — revisit the acceptance criterion before development begins.
- Glyph shift on the frame of entering/exiting editing (Monaco's fractional metrics) → scale snapping and pixel-by-pixel comparison in spike C (D9); there's no frame-by-frame synchronization during panning — the camera is stationary in the editor.
- Monaco itself exceeds 8 ms on typing, model switching, or IME → minimal configuration (D9), typing/paste/model-switch scenarios in the harness; if the budget is unattainable — a stop point with the user, not a silent exclusion from the criterion.
- Blurry text at fractional zoom → spike G chooses between a discrete atlas and MSDF before `rendering/text` is implemented.
- Monarch doesn't run in a worker → a stop point after spike D, an alternative tokenizer in the worker (D7); the main thread never does tokenization.
- A Detail Level transition switches every widget in the same frame → both representations are ready ahead of time, the switch is one uniform; spike E measures the worst case.
- Changing the atlas raster size mid-zoom causes a spike in rasterization and loading → the atlas doesn't change during an active gesture, neighboring sizes are prepared ahead of time outside the frame, loading goes through the budgeted queue; harness scenario "zoom across an atlas size boundary".
- A flood of worker responses after opening a folder → `DocumentResidency`'s budgeted drain with visible files first and stale versions dropped (D7); scenario "Pan during initial load".
- One concept split across modules hides bugs in the coordination → single owners: `EditingTransition` for entering/exiting, Board for Detail Level and hit-test, `DocumentResidency` for text-to-GPU, `GestureTargeting` for input routing (D4, D7–D9).
- An absolute zero of dropped frames is unattainable due to OS noise and trace recording → the criterion is relative to the noise floor of the same session (spec `performance-budget`).
- Integrating components that were only verified individually → a vertical slice right after the spikes, before the harness and the contexts (tasks, group 3).
- DDD adds layers and files → technical modules with no domain layer (D1), projections for the hot path (D5); the linter enforces boundaries so agents can't cut corners.
- The harness's synthetic gestures don't behave like a real trackpad → the final criterion is manual acceptance with real gestures (spec `performance-budget`); the harness is a regression check.
- The harness itself may lie (false "green" results) → a self-test with artificial CPU and GPU load, cross-checking the frame count against the DevTools panel on the same trace, a weekly manual trackpad trace for comparison.
- An agent "fixes" a regression by updating the baseline → the update requires interactive human confirmation.
- A full run requires a visible window, the agent waits on a human → stage-timing mode for agent iteration, a full run at least twice a day.
- The 800-line limit invites splitting into small, highly coupled files → `max-lines-per-function` and `complexity` matter more than the file-size limit; review looks at module cohesion, not just size.

## Migration Plan

Not applicable: a new product with no previous versions or data. Rollback is `git revert`.

## Open Questions

- The numeric Detail Level thresholds, the hysteresis band width, the minimap texture width, and the set of atlas raster sizes — are determined by spikes E and G, within the approach already chosen.
- The noise-floor threshold at which a measurement is declared invalid — based on the results of spike A and the first floor measurements.
- The size of the line window around the visible area and the per-frame rebuild budget (default 2 ms) — are calibrated by the harness.
