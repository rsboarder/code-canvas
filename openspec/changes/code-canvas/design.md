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
- A hot frame path (pan/zoom/drag) with no per-widget/per-glyph allocations and no waiting on workers.
- An architecture where every risky assumption from the research is closed by a spike before main development.
- A set of linters and gates that an agent runs with a single command.

**Non-Goals:**
- Multi-user support, a backend, deployment.
- Languages other than TypeScript/TSX; line wrapping. Wide characters (CJK, emoji) are drawn with the advance the browser's text engine gives them (≈1.7 narrow advances from the fallback font, not 2 — spike C, confirmed 2026-09-29), the same advance Monaco's DOM uses, so they stay aligned with the editor. Emoji are drawn as Canvas2D draws them — in colour, as in Monaco's DOM; colour emoji are not a requirement (user's decision, 2026-10-01).
- Font ligatures and right-to-left text: the tile raster draws one grapheme cluster at a time at LineLayout's x (D4, D6) and does not shape runs, so the GPU view keeps one arithmetic layout (VS Code's GPU renderer and xterm.js's WebGL renderer have the same limit). Ligatures are off in the editor too, so both views show the same glyphs.
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
| `rendering` | generic (technical) | GPU mechanics: context, Text Tiles and their raster workers, passes; the generic frame-stage runner | TilePool, WidgetTable, GpuUploader adapter, RenderPass, FrameLoop |
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

                      per-frame pulls (Frame Stages declared by app, run by FrameLoop, no events)
 app ──stage list──▶ FrameLoop ──runs──▶ interaction, board, rendering, code-view, editing stages
 FrameLoop ──Frame Sample (shared/frame)──▶ performance (FrameStats, overlay)
```

- **workspace → board**: `FilesDiscovered(folderId, files)` (each file: `SourceFileId` + line count) → board's `restoreBoard` loads the saved layout for `folderId` and reconciles it with the discovered files in one step (D12). Board references files only by `SourceFileId` and folders only by `WorkspaceFolderId`; it never sees file-system handles.
- **workspace → board, code-view**: `FileContentChanged(fileId, contentVersion, text, lineCount)` on every new Content Version — a read from disk or an applied Draft. This is the only path by which text reaches `code-view`: `DocumentResidency` takes the text; board updates the widget's content height and re-clamps its Content Scroll.
- **Content Version vs File Revision**: Content Version is an in-memory counter per Source File, bumped synchronously on every text change; it keys tokenization and GPU data. File Revision is the content hash of what is on disk; it guards writes against conflicts (D12). Keeping them apart lets a Draft reach the screen in the same frame while the hash and the write stay asynchronous.
- **editing ↔ workspace**: editing calls workspace's application services `readForEditing` (with conflict detection) and `applyDraft(fileId, text)`. `applyDraft` synchronously bumps the Content Version and emits `FileContentChanged`, then schedules the asynchronous write. Conflict is a workspace concept.
- **Exiting with edits**: the `EditingTransition` module (D9) applies the Draft, marks the file as a priority in `DocumentResidency`, and hands the FrameLoop one swap record. The FrameLoop applies it in the first tick in which the widget's visible Text Tiles are current for the new Content Version (single colour allowed, D6); until then Monaco stays visible and stationary, and the gesture that ended the session keeps accumulating as the pending gesture — the camera does not move. In that tick Monaco is hidden, the tiles are shown and the pending gesture replays, so no frame shows the old content (spec `code-editing` "Exiting editing"); highlighting arrives from the worker within 100 ms. The hold is bounded by one widget's visible tiles in the raster workers: estimated 1–2 frames from spike H2's per-tile medians (raster ≈1 ms at zoom 1, transfer and upload ≈4 ms); the harness measures it (task 11.8). An exit without edits swaps in the same tick: the tiles are already current. Rejected (user's decision, 2026-10-01): keeping Monaco until the *tokens* are ready (ties the hold to tokenization, up to 100 ms), and rasterizing the widget on the main thread in the swap tick (main-thread tiles alone reached 6.2 ms JS p99 in H2).
- **interaction → board/editing**: only application-layer commands, produced from per-frame intents of `GestureTargeting` (D8); no direct mutation of domain objects.
- **Per-frame work**: each context exposes its Frame Stage through its public `index.ts`; `app` wires the D8 order into the FrameLoop. `rendering` contributes only the cull and draw stages and receives the projections it draws (WidgetTable rows, Camera, Detail Level) from `app`'s wiring, so it imports no core context (D5). No stage subscribes to domain events or writes to another context's domain.

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
- Only core contexts have a public `index.ts` entry that other modules may import. Technical modules (`rendering`, `interaction`, `performance`) may import core contexts' `index.ts` (e.g. `rendering` implements code-view's `GpuUploader` port, `interaction` calls Board's hit-test), but no module imports a technical module except `app`; `performance` reaches frame data only through the Frame Sample type in `shared/frame`, and `perf/` only through `performance/bridge.ts`.
- These rules are declared once, as a **Module Map** table (modules, layers, public entries, allowed edges, where each library may be used), from which the lint rules and knip entries are generated; a matrix test over real `src/` paths checks every allowed and forbidden edge (D10).

### D4. Aggregates and invariants

- **Board** (the root) with **Widget** entities. Invariants: one widget per `SourceFileId`; `WidgetFrame` is never smaller than the minimum; `StackOrder` is a strict order with no duplicates; `ContentScroll` stays within `[0, contentHeight − viewportHeight]`, recomputed on resize and whenever the line count changes. **Camera** is a value object inside Board: scale in `[0.05, 4.0]`, zooming toward a point keeps that point under the cursor. `GridLayout` is the domain policy for the initial layout; `reconcile(savedLayout, discoveredFiles)` is a pure policy that keeps saved widgets, drops missing files, and places new files to the right of the grid.
- **DetailLevel** lives in Board next to Camera. The on-screen line height (`lineHeight × zoom × DPR`) is the same for every widget, so there is one Detail Level per Camera, not per widget. Board stores the current level and applies hysteresis (different thresholds for zooming out and zooming in) whenever the Camera changes; a switch to Text also waits until the visible widgets' Text Tiles are resident, an input the frame passes in (D6 "Detail Level transition"). The base line height is configuration given at composition from `code-view`'s LineLayout. `rendering`, `interaction` and the metrics overlay only read it. Numeric thresholds are set after spikes E/G.
- **Hit-test** is a pure query on Board: top-most widget under a screen point, then the zone (header, edge, body, empty canvas); for the body it returns a body-local point in content coordinates (Content Scroll applied). It uses the same Widget Frames, Stack Order and Camera as rendering. Turning that point into a line and column is LineLayout's job, so Board's domain holds no text rules.
- **LineLayout** (`code-view/domain`, pure) is the single owner of "text → rows and x positions":
  - **Line splitting matches Monaco's text model** (user's decision, 2026-09-29): breaks are LF, CRLF and CR; a leading BOM is not a character; the empty file is one empty line; a trailing line break produces a final empty line (a 2000-line file ending in `\n` has 2001 lines, the last one empty). Monaco is the reference the GPU view swaps with, so line numbers and Content Scroll agree by construction.
  - Iteration is by **grapheme cluster** (`Intl.Segmenter`, granularity `grapheme`, as VS Code's GPU renderer does): the browser draws a cluster — a ZWJ emoji sequence, a base letter with combining marks, a flag, an emoji with a variation selector — as one glyph with one advance, so summing its code points' advances is wrong (the Text Metrics conformance test measured a 40 px shift after one ZWJ sequence, 2026-09-29). Surrogate pairs are inside clusters (`charAt` splits them, spike E). One cluster = one `fillText` in the tile raster and one Text Metrics advance; UTF-16 offsets still address columns for Monaco and tokens. Tab stops go to the next multiple of the tab size, as Monaco does.
  - **Advances are fractional, per code point** (spike C): a glyph's x is the prefix sum of the advances before it. Integer cells are not enough: CJK and emoji are ≈1.7 narrow advances wide. LineLayout does not measure anything; it receives **Text Metrics** (narrow advance, `advanceFor(codePoint)`, baseline, line height) as configuration at composition. Where Text Metrics come from is D6 "Text Metrics".
  - UTF-16 offset ↔ x position conversion, the hit-test column, the worker's token offsets, the GpuUploader line windows, workspace's line count and Monaco's options (`tabSize`, end of line, `fontSize`/`lineHeight`) all derive from it; the line-splitting rule itself lives in `shared/domain` so workspace can count lines without importing code-view. The Reference Dataset generator uses the same rule (`fixtures/lib/dataset.ts` `splitSourceLines` is its reference implementation until `shared/domain` exists), and the Edge-case Corpus `expected` records are LineLayout's test table.
  - Five splitting rules existed before this decision (fixtures, spikes C/E, spike D2's worker, `check-max-lines`, Monaco); spike D2's worker split on `\n` only, leaving `\r` in line text and shifting token offsets. Product code never splits lines itself.
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

- **A single WebGL2 context** for the whole application, on the main thread (research, items 2/5). Moving the scene to OffscreenCanvas in a worker was rejected: swapping the GPU representation for Monaco and back must happen within a single frame together with the DOM, and cross-thread synchronization via `postMessage` doesn't guarantee that. Text Tiles are *rasterized* in workers (below), but composited by this context. The camera is stationary while editing (spec `code-editing` "Stationary editor"), so there's no need for frame-by-frame synchronization of Monaco with panning.
- **Raw WebGL2 + twgl.js** (research, Tradeoff Matrix). Fallback path — PixiJS v8 with a custom Mesh, if spike B shows that a homegrown renderer won't fit the schedule.
- **Text Tiles** (spike H2, user's decision 2026-10-01): a widget's body — line numbers and code — is drawn from square RGBA images of 512 × 512 device px. A tile covers a fixed square of the widget's *content* at one raster scale (camera zoom × DPR): tile (column, row) covers content x ∈ [column·s, (column + 1)·s) and y ∈ [row·s, (row + 1)·s), with s = 512 / rasterScale CSS px (256 CSS px at zoom 1, DPR 2). Tiles are anchored to content coordinates: pan, drag and resize only move or clip them (Camera and the widget's `WidgetTable` row, a data texture the shader reads), and in-widget scroll shifts them by the Content Scroll in the shader — a sub-tile offset plus one extra row at the edge, with no raster until a new row enters (H2 scrolled in whole tile rows; smooth scroll is measured by the harness). Rejected: the glyph atlas — its per-frame cost grows with the visible glyphs (H2 on 80-line files: density JS p99 16 ms, GPU p99 11.5 ms) and it crashed the renderer on full-size files; tiles rasterized on the main thread (JS p99 up to 6.2 ms). Spike G's discrete atlas sizes applied to the atlas and no longer apply.
- **Raster workers**: a small pool of module workers, separate from the Tokenizer pool so a tokenization chunk (~18 ms) never delays a visible tile (size calibrated by the harness; 2 to start), rasterizes tiles with `OffscreenCanvas` 2D: the widget background, then one `fillText` per grapheme cluster at LineLayout's x and the Text Metrics baseline with its palette colour (spike H's `drawRasterCells`); tabs are expanded per LineLayout, ligatures are disabled. Each worker draws with the one font definition in `shared/font.ts`, which also configures Monaco — today the system Menlo the Text Metrics were measured with (a font file, if one is ever bundled, is loaded through `FontFace` in each worker); at start-up its `measureText` of the probe character must equal Text Metrics' narrow advance, or the app stops with an error instead of drawing with a fallback font. A job carries the tile key and its lines' cells as transferable typed arrays (code points, x offsets, colour indexes); the result is a transferable `ImageBitmap`; a tile whose Content Version or raster scale is no longer wanted when it arrives is closed (`ImageBitmap.close()`), never uploaded. The main thread only uploads (`texSubImage2D` from the bitmap — ≈0 ms of main-thread time per tile in H2) and composites. Measured per tile in H2 (worker): raster median 0.8–1.0 ms at zoom 1 and 6.1–6.4 ms at the density zoom 0.225, where one tile holds a whole widget body.
- **Tile pool**: fixed RGBA slots in GPU texture memory, allocated outside the frame and never re-created inside one (H2: one 3072² px texture, 36 slots, 36 MiB — enough for its 1200 × 720 CSS-px view); sampling never bleeds between slots (a texture array, or gutters in an atlas). At rest, a tile quad sits on whole device pixels (its screen translation is rounded), so its texels map 1:1 to the screen; a sub-pixel offset would blur the text through `LINEAR` filtering. The product sizes it from the viewport — the visible tiles, a one-tile margin ring and the old-scale tiles kept while a zoom settles — and adds a page outside the frame if they do not fit. Slots are reused least-recently-used; visible and fallback tiles are never evicted. Uploads never set `UNPACK_FLIP_Y_WEBGL` (the flip lives in the tile UVs). Tile memory and missing-tile frames go into the Frame Sample.
- **Zoom**: a tile is sharp at its raster scale and scaled by the GPU (`LINEAR`, no mipmaps) at any other. During a zoom gesture resident tiles are drawn scaled and not re-rasterized. Widgets the gesture is about to reveal — those in the view at the next power-of-two zoom step around the focus point — get tiles during the gesture at a coarse scale (the largest power of two not above the current zoom), so a widget entering the view usually has text in its first frame; a frame where a visible widget has no resident tile counts as a missing-tile frame (H2: 1–2 per run). When GestureTargeting reports the gesture's end (it owns gesture boundaries, the momentum phase included; rendering keeps no settle timer of its own), the visible tiles are re-rasterized at the exact settled scale; the old tiles stay on screen, scaled, until every visible replacement is resident (H2), so no frame is empty. The exact scale and the same font engine as Monaco's DOM — which also rasterizes at its final scale under the CSS transform (D9) — make the frames before and after an editing swap match. Time to sharp (gesture end → last replacement resident) was not measured in H2; from the per-tile costs it is estimated at tens of ms at zoom 1 and ~0.1–0.2 s at the density zoom with two workers; the harness measures it.
- **Text Metrics** (`rendering/text`, decided 2026-09-29 after 3.2's alignment failures and a research pass on VS Code's GPU editor renderer): one module measures the font with the **browser's text engine** and is the only source of horizontal advances and the baseline for the GPU view; Monaco is configured from the same font definition and is not a source of metrics. In Chrome, Canvas2D `measureText` and DOM layout use the same `blink::Font`/HarfBuzz shaping (measured 2026-09-29: identical advances to 0.001 px for ASCII, Cyrillic, CJK fallback and emoji at 16 px Menlo).
  - Inputs: the one font definition in `shared/font.ts` (family, size, line height, tab size, `font-feature-settings` with ligatures off, `letter-spacing` 0) — the same object configures Monaco.
  - Narrow advance: a laid-out, hidden DOM `<span>` of the probe character repeated 256 times, `width / 256` (VS Code `charWidthReader`); per-code-point advances: Canvas2D `measureText` with `fontKerning`, `letterSpacing` and feature settings mirrored from the DOM style, cached per code point, measured lazily on the main thread outside the frame (through the drain budget); the raster workers receive x positions and never measure.
  - Baseline: CSS half-leading from one `measureText` per font and size — `floor((lineHeight − (fontBoundingBoxAscent + fontBoundingBoxDescent)) / 2) + fontBoundingBoxAscent` (VS Code `fullFileRenderStrategy`); measured 15 px for 16/20 Menlo, equal to Monaco's DOM.
  - One rounding rule, applied here and nowhere else (xterm.js's WebGL and DOM renderers diverge because each floors the shared width differently).
  - Monaco options that keep its DOM on the same metrics: ligatures off, `letterSpacing` 0, no line numbers, glyph margin, folding, line decorations or indent guides, `renderLineHighlight: "none"`, background from the one theme object. `disableMonospaceOptimizations: true`: with Monaco's monospace fast path its ASCII advance measured 9.641 vs the engine's 9.633 (≈1 px per 120 columns); with the option on, Monaco positions glyphs by DOM layout and the conformance test measured max |Δx| ≤ 0.04 CSS px and baseline Δ 0 on the Edge-case Corpus at zoom 1 and a snapped zoom (2026-09-29).
  - Verification is a **conformance test**, not a pixel ratio: over the Edge-case Corpus and a Reference Dataset file, every cluster's LineLayout x — where the tile raster draws it — equals the x of the same glyph in Monaco's DOM (`Range` rects) within `zoom × n / 128 + 0.05` CSS px, where `n` is the number of Monaco token spans before the glyph on its line, and the baseline is equal within 0.5 CSS px, at zoom 1 and non-integer zooms (0.8, 1.37, 2). The span term is the browser's, not Monaco's: Chrome rounds each inline fragment's width to a LayoutUnit (1/64 px), so the DOM x drifts from the sum of advances by at most 1/128 px per fragment boundary. Measured 2026-09-29 on a 171-column ASCII line: 1-, 5-, 20-character spans and a single span drift 1.33, 0.266, 0.008 and 0.008 px at the last column, at transform scale 1 and 2 alike. The GPU view does not emulate this rounding — that would couple the layout to Blink's LayoutUnit and to Monaco's span splitting; like VS Code's GPU renderer, it keeps one arithmetic layout. On a widget's visible width the drift stays under one device pixel for typical code.
- **Units** (task 3.1): world and Camera are in CSS px; every pass converts to clip space with one transform that takes a DPR uniform; tiles are rasterized at the raster scale (zoom × DPR) and drawn as quads in world units. The minimap quad samples only the uploaded rows, one minimap row per content line; the minimap tile size is a uniform, never a shader constant. Rendering tasks are verified with e2e at `deviceScaleFactor: 2` asserting pixels from screenshots, plus a one-off probe with console listeners and 1:1 captures — the half-size-on-DPR-2 defect of 3.1 was invisible in downscaled screenshots.
- **Line window**: the uploader holds a widget's cells for the visible lines plus one screen's worth of margin above and below, from which its tiles are rasterized; when scroll moves outside the window, `DocumentResidency` rebuilds it within its drain budget (D7, D8). Pixels exist only for the visible area and a one-tile margin ring — never for all 2000 lines × 200 files.
- **Per-widget clipping** — in the fragment shader, against the widget body rectangle from `WidgetTable` (one instanced draw for all tile quads, no per-widget scissor).
- **Stacking order via the depth buffer**: each widget gets a unique depth from `StackOrder`. Pass 1 — opaque widget backgrounds/frames, writing depth; pass 2 — content: tiles when the Detail Level is "Text", minimap quads when it is "Minimap", depth test `LEQUAL` with no write. This way the content of a widget below doesn't show through the background of one above; since all widgets share one Detail Level, each frame draws exactly one kind of content. Translucent backgrounds, shadows, and rounded corners with cutouts are not supported by this scheme.
- **Minimap** (Detail Level "Minimap"): the strip image is built on the CPU in the tokenization worker right after tokenization — a `Uint8Array` of palette indices (R8, 0 = background), one texel row per line of code, fixed width 256 texels (spike E: the whole Reference Dataset's minimap atlas is 26 MB R8), bounded height (long files are decimated). The texture is transferred to the main thread as a transferable and loaded into a shared minimap texture atlas through `DocumentResidency`'s budgeted drain (D7); color is looked up in the shader from the palette, `NEAREST` filtering by index, no mipmaps (averaging indices is meaningless). At far zoom, a widget is a single quad sampling the file's visible slice. A naive RGBA-with-mipmaps variant was rejected: on the order of hundreds of MB for 200×2000 lines (a design-review estimate, not a measurement); "a rectangle per token run" was rejected: up to ~1M instances.
- The **file path** — in the header at Text and in a large font over the minimap — is drawn from label tiles: the raster workers draw it once per widget and raster scale; label tiles live in the tile pool and scale during gestures like Text Tiles.
- **Detail Level transition** — an instant switch of the single Detail Level within one frame, with hysteresis (research risk #5). A crossfade was rejected: with overlapping widgets in the transition band, blending two translucent representations breaks the stacking order, and the spec only requires the absence of empty frames. Zooming out, the scaled tiles stay until the switch to Minimap, whose textures are ready (spike E: Minimap frame GPU p99 1.09 ms, 8 switches with no empty frame; its zoom-sweep trace, re-derived with the corrected classifier — see D13 — has 1 dropped frame of 701, none partially presented). Zooming in, text cannot be ready ahead of time for every widget (a widget at the threshold scale is one 1 MiB tile, ~200 MiB for the dataset): when a zoom-in gesture starts at the Minimap level, the raster workers start on the tiles the threshold view will need — the widgets visible at the Text threshold zoom around the gesture's focus point, at that zoom's raster scale — and Board switches to Text only once the visible widgets' tiles are resident (D4); until then the Minimap stays, so no frame shows an empty widget or two representations (spec `code-widget-rendering` "Transition without flicker"). On a fast zoom-in the switch can lag the threshold by the raster time of the visible set (estimated ~0.1–0.2 s; user's decision, 2026-10-01, over keeping a threshold tile for all 200 widgets). H2 never crossed the threshold; the harness scenario "Zoom from "Fit all" to 4.0 and back" does.
- **Draw calls per frame**: 3–5. Culling — brute-force iteration over 200 AABBs, no spatial index.

### D7. Tokenization

- There is a single source of color: the theme object, from which both `monaco.editor.defineTheme` and `ThemePalette` (`code-view/infrastructure/theme.ts`) are built — color matching by construction.
- The tokenizer is a **TextMate grammar** (TypeScript and TSX) run by `vscode-textmate` with the `vscode-oniguruma` WASM regex engine in a Web Worker. There is no tokenization of widget text on the main thread: that would contradict spec `performance-budget` "No background stalls". The `Tokenizer` port in `code-view/application` hides the implementation.
- Monaco (editing) uses the **same** grammar and the same scope-to-colour theme through a custom tokens provider, so a file's colours are identical in a widget and in the editor (spec `code-widget-rendering`); the editor tokenizes only the one file being edited.
- Why not Monarch (decided by the user after spike D, 2026-09-28): spike D proved Monaco's Monarch TypeScript grammar runs in a worker and matches Monaco byte for byte, but that grammar has no JSX rules and does not distinguish function identifiers, which spec `code-widget-rendering` "TypeScript syntax highlighting" requires. The spike D findings about the worker build (exports-map import form, the `editor.api.js` shim) no longer apply to the tokenizer; they still apply to how the editor loads Monaco.
- Spike D2 (task 2.9) settled the grammar and theme: `tm-grammars` `source.ts`/`source.tsx` and Dark Plus from `tm-themes`, converted from VS Code's `tokenColors` to `vscode-textmate`'s `IRawTheme.settings` (a plain cast silently yields only fallback colours). Zero worker ↔ Monaco colour mismatches over 55.7M characters; packed runs are `[line-relative offset, colour id]` pairs, ~460 KB per 2000-line file. The production build loads the WASM in the worker; the Vite dev-server WASM path was not measured.
- Cost (spike D2, production build): a cold 2000-line file takes ~375 ms, 12× Monarch; the whole dataset ~75 s in one worker. With a per-line rule-stack (`StateStack`) cache, the first visible 60-line window takes ~10.5 ms, re-tokenizing after a one-character edit ~0.6 ms (a full rescan 182 ms), a 100-line chunk ~18 ms. Hence the Tokenizer interface below is incremental and chunked, not whole-file.
- **Worker pool** (user's decision, 2026-09-29): the Tokenizer adapter runs a pool of workers (size from `navigator.hardwareConcurrency`, 4–6 on the reference machine, leaving cores to the main thread and the GPU process) so the cold dataset finishes in roughly 15–20 s (an estimate from ideal scaling; the harness measures it). Each file is pinned to one worker, so its rule-stack cache lives in one place.
- **DocumentResidency** (`code-view/application`) owns each Source File's path from text to GPU-ready data: text, Content Version, tokens, minimap bytes, the visible line range, and whether it is still unhighlighted. Its interface is small: `contentChanged(fileId, version, text)`, `visibleRangesChanged(ranges)` (from the FrameLoop after culling), `prioritize(fileId)` (from `EditingTransition`), and `drain(budget, uploader)`. It translates visible ranges and priority into the Tokenizer's ranked `wanted` line ranges. Ordering (priority, then visible, then the rest), staleness and the single-color fallback live only here. It is one folder module with one entry point: its internal parts (the priority queue, the Content Version ledger that drops stale results, the line-window planner, budget accounting) are implementation details, not imported from outside the folder and tested only through the four methods with the fake `Tokenizer` and a recording `GpuUploader`.
- Internal seam `Tokenizer`: the worker-pool adapter in production, a synchronous in-process fake in tests (two adapters). The theme and grammar are given once, when the adapter is constructed, never with each request. The adapter owns, per Source File, the current Content Version, the rule-stack cache and a resumable queue of line chunks (~100 lines); the cache is a live object inside the worker, which is why the interface speaks in content changes and line ranges, not whole-file jobs (user's decision, 2026-09-29, after the architecture review). `DocumentResidency` sends `contentChanged(fileId, contentVersion, text)` and `wanted(fileId, lineRanges)` in its priority order (priority, visible, the rest); the adapter tokenizes the wanted ranges first, resuming from the cached state before them, and can drop or reorder queued chunks between chunks, so no request blocks a worker for more than one chunk. Responses are `(fileId, contentVersion, line range, Token Runs)`, plus the minimap bytes once a file is complete; results for one file arrive in order. A stale response is dropped inside `DocumentResidency`, before anything is queued for the GPU. Results (`Uint32Array` of Token Runs, `Uint8Array` of minimap data) are transferred as transferables, without copying.
- External seam `GpuUploader`, declared in `code-view/application`: it accepts line windows — cells (code points and x offsets per LineLayout) with palette colour indexes, tied to a Content Version — and minimap bytes. `rendering` implements it with WebGL; tile planning, the raster workers and the tile pool belong to that adapter (Text Tiles are rendering's concept, D6). Its per-frame main-thread work — posting raster jobs and uploading the tiles that came back — runs inside `drain`'s budget; a worker's message handler only queues the result. Tests use a recording fake. The whole path "text changed → uploads issued" is therefore testable with no worker and no GL.
- `drain` serves a prioritized file's visible line window and uploads that widget's tiles as they arrive regardless of the budget (bounded to one widget); everything else stays within the budget.
- Until tokens are available, the widget is drawn in a single color (spec `code-widget-rendering`).

### D8. Frame cycle and work budget

- A single `FrameLoop` driven by `requestAnimationFrame`, running only while there are "dirty" changes or a gesture is in progress; it does not spin at rest. It is a generic stage runner (`rendering/frame-loop.ts`): its interface is an ordered list of named **Frame Stages** plus the "dirty or gesture in progress" rule. It times every stage and, once per frame, hands one **Frame Sample** (stage times, Detail Level, visible widget count, residency backlog) to `FrameStats` through the type in `shared/frame`. `app` declares the stage list below in one place; each context contributes its stage through its public `index.ts`. A unit test with recording fake stages checks the order.
- Tick order: `GestureTargeting` turns accumulated input into intents → commands to board/editing → Camera and Detail Level → drain Board's dirty widget ids into `WidgetTable` → culling → `DocumentResidency.visibleRangesChanged` → apply `EditingTransition.takeFrameSwap()` once the widget's tiles are current (D2) (Monaco container, widget visibility, priority file) and replay the pending gesture → `DocumentResidency.drain(budget, uploader)` (default 2 ms; line windows, tokens, minimaps, and the uploader adapter's tile work — raster jobs posted, returned tiles uploaded; the remainder carries over, priority then visible first) → draw.
- The same-frame swap on exiting editing and the budgeted drain do not conflict: the swap record and the prioritized widget's line window and tile uploads are the only work allowed outside the budget, and both are bounded to one widget.
- Fast scrolling inside a widget: the line window has margin, and if the rebuild didn't finish in time, the frame draws the already-loaded window, missing lines are loaded in subsequent frames; a tile row that is not resident yet shows the widget background for those frames (counted as missing-tile frames). The harness includes a maximum-speed scroll scenario with a queue-depth metric.
- The hot input path has no per-event allocations: intents and commands take primitives, and there are no hot-path domain events (D5).
- Input: `wheel` on the canvas, non-passive, with `preventDefault` (pinch = `wheel` + `ctrlKey`); pointer events with `setPointerCapture`. Events accumulate and are applied once per frame.
- **Pinch follows the fingers** (user's decision, 2026-10-01): Chrome reports a touchpad pinch of scale s as ctrl+wheel events with Σ deltaY = −100·ln s, so each event zooms by `exp(−deltaY / 100)` — a pinch of ×2 zooms by ×2. Each event's |deltaY| on the zoom path is clamped to 10, so one Ctrl + mouse-wheel notch zooms by about 10% instead of jumping. The vertical slice's `exp(−deltaY · 0.002)` zoomed a ×2 pinch by ×1.15.
- **GestureTargeting** (`interaction`) is the one module that decides what a gesture does. It picks the target when a gesture starts, using Board's hit-test, the Detail Level and whether an Editing Session is active, and keeps that target until the gesture ends, including the OS momentum phase: a scroll that reaches a widget's content edge stays on that widget; wheel over the editor goes to Monaco; pan or zoom on the canvas while editing ends the session and carries on as a pending gesture; drag and resize of the active widget are refused. Its interface is raw events in, per-frame intents out, so every routing scenario in the specs is a unit test over a recorded event sequence, with no browser.

### D9. Monaco

- One instance per application, files are switched with `setModel()`; models are created on entering editing and disposed on exit (we don't keep 200 models).
- The DOM container over the canvas is placed once on entering editing; the camera and the active widget's geometry stay stationary until exit (spec `code-editing` "Stationary editor"). Wheel input over the container is handled by Monaco; any other input on the canvas ends the session.
- Monaco's configuration is minimal: no minimap, overview ruler, word wrap, code lens, diagnostics, or semantic tokens.
- **Metric alignment**: Monaco always receives the base `fontSize`/`lineHeight` from `shared/font.ts`; its container is scaled to the camera zoom with CSS `transform: scale(zoom)` (origin top-left, no `will-change`). Monaco's layout is then the zoom-1 Text Metrics layout — the same one the GPU view scales — at any zoom and for any font, including fallback fonts whose advances do not scale linearly with font size. Measured 2026-09-29 in Chrome at DPR 2: emoji advances are 20/21/22/24 px at font sizes 16/17.6/20/24 (Menlo and CJK scale linearly); against the zoom-1 layout × zoom, Monaco with `fontSize` × zoom deviated up to 16.7 CSS px at zoom 2, with CSS `zoom` up to 16 px, with `transform` ≤ 0.03 px at zoom 0.8/1.1/1.37/2; clicks landed on the right column in 37 of 37 clusters and drag selection was exact in every mode; text under the transform is rasterized at the final scale, as sharp as a native font size. The camera is not snapped on entering editing: the earlier snap existed only because Monaco rounds a fractional `lineHeight`, and the base `lineHeight` is whole. The horizontal step and the baseline come from Text Metrics (D6), which Monaco's DOM shares by construction; Monaco is never probed for metrics. Spike C matched the frame before and after entry within ~1.5 CSS px at zoom 0.8/1/1.37/2 with Monaco-probed metrics; the product's first attempt to probe Monaco (`getScrolledVisiblePosition` deltas over a probe model) produced zero and inflated advances for code points outside the laid-out viewport and a guessed baseline, and was replaced by Text Metrics (2026-09-29). Acceptance is D6's conformance test at zoom 1 and non-integer zooms.
- **Loading Monaco** (spikes B/C/D, Monaco 0.57): import through the `exports` map without `esm/vs/` (`monaco-editor/editor/editor.api.js`), never the package's full entry — it registers the TypeScript language service; internal APIs moved (`model.tokenization.*`); the editor needs `self.MonacoEnvironment.getWorker` with its editor worker.
- **Task budget** (user's decision, 2026-09-29): spike C saw 1–2 main-thread tasks of 9.9–11.8 ms per action (typing, paste of 500 lines, undo, model switch; earlier runs up to 21.5 ms), 0–2 dropped frames and 32–40 ms from input to the next paint, but could not separate Monaco from its own harness. Accepted for now; the performance harness measures Monaco in the product (tasks 4.x, 11.8), and a miss there is the AGENTS.md stop point again.
- **EditingTransition** (`editing/application`) owns the whole enter/exit sequence, so the "one frame" invariant lives in one module. `begin(widgetId, clickPoint)`: `readForEditing` with conflict check, Monaco model and its scaled container through the `EditorHost` port. `end(reason, pendingGesture?)`: `applyDraft` if there are edits, `DocumentResidency.prioritize`, model disposal. `takeFrameSwap()`: one record the FrameLoop applies atomically in a single tick — the first one in which the widget's tiles are current for the new Content Version (D2) — hide or show the widget's GPU representation, place or remove the Monaco container, the pending gesture to replay. `EditorHost` has two adapters: Monaco in production, a fake in tests, so every exit reason in the spec (Escape, click outside, pan, pinch, double click on another widget) is tested without Monaco or WebGL.

### D10. Linting and quality gates

A single `pnpm check` command (the agent must run it before committing; the pre-commit hook repeats it on changed files):

| Check | Tool | What it catches |
|---|---|---|
| Types | `tsc --noEmit`, `strict` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noImplicitOverride` | type errors |
| Lint | ESLint flat config + `typescript-eslint` `strictTypeChecked` and `stylisticTypeChecked` | unsafe TS, floating promises |
| File size | ESLint `max-lines: 800` (blank lines and comments count) + a `check-max-lines` script for non-TS sources (`.glsl`, `.css`) | the "≤ 800 lines" requirement |
| Function size/complexity | `max-lines-per-function: 80`, `complexity: 15`, `max-depth: 4`, `max-params: 4` | code bloat from agents |
| Architectural boundaries | `eslint-plugin-boundaries` generated from the Module Map (D3), with origin and unknown-file checks on; a matrix test over real `src/` paths; rules independent of the working directory | layer violations, deep imports, files outside a declared module |
| Library restriction | `no-restricted-imports` and `no-restricted-syntax` (static and dynamic `import()`, including subpaths): `monaco-editor`, `twgl.js` outside allowed directories; DOM globals in `domain` (via `no-restricted-globals`) and a DOM-free `tsconfig.domain.json` | infrastructure leaking into the domain |
| Cycles | `import-x/no-cycle` with the TypeScript resolver | circular dependencies |
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
    domain/                    Id types, DomainEvent, Result, the line-splitting rule
    events/                    the typed synchronous bus
    frame/                     Frame Stage and Frame Sample types
  workspace/  {domain,application,infrastructure,index.ts}
  board/      {domain,application,infrastructure,index.ts}
  code-view/  {domain,application,infrastructure,index.ts}   domain: LineLayout; application: DocumentResidency/; infrastructure: the Tokenizer worker-pool adapter (workers, grammar, rule-stack cache, palette mapping), theme.ts
  editing/    {domain,application,infrastructure,index.ts}   application: EditingTransition; infrastructure: monaco-editor-host.ts
  rendering/
    gl/                        context, programs, buffers
    text/                      font, Text Metrics, the tile raster worker
    scene/                     WidgetTable, GpuUploader adapter (tile planner, tile pool, minimap atlas)
    passes/                    background, tile, minimap
    shaders/                   *.glsl
    frame-loop.ts, index.ts
  interaction/                 GestureTargeting, shortcuts
  performance/                 FrameStats, overlay
  app/                         main.ts (composition root), screens: folder picker, notifications, toolbar
perf/                          the performance harness (D13)
fixtures/                      the Reference Dataset module (in-memory generator + feature profile, a thin CLI writes it to disk) and the Edge-case Corpus
tests/e2e/                     functional Playwright scenarios
spikes/<letter>/               throwaway spike pages (group 2), one Vite entry each
```

Spike code in `spikes/` is research, not product: it is typechecked and formatted, but excluded from the boundaries, max-lines/complexity and knip rules, and nothing in `src/`, `perf/` or the root build config (`vite.config.ts`) imports it. Reusable findings move into `src/` through regular tasks, never by importing a spike; a build hook a spike needs lives in that spike's own config. Spike D2's worker built with the plain root config, so the Tokenizer adapter needs no Vite hook of its own; what matters is a gate test that **fails** (spike D2's check only logged) when the worker chunk contains a Monaco or CSS module. Spikes typecheck in their own tsconfig program, so one spike's ambient `declare module` cannot break another's types (it did: spike C's Monaco typings broke D and E), and a spike that needs a build hook has its own `spikes/<x>/vite.config.ts`.

The Reference Dataset is the performance worst case; the **Edge-case Corpus** is a small, separate set of Source Files for correctness (CRLF, CR, BOM, blank lines, empty files, trailing whitespace, lines longer than 300 characters, wide characters, tabs at every column) that feeds the LineLayout, Tokenizer and DocumentResidency tests. The dataset's determinism and feature profile are checked by a Vitest test inside `pnpm check`, generating in memory with no disk round trip.

### D12. Storage

- The folder handle is stored in IndexedDB; on startup, `queryPermission`, and if needed, `requestPermission` on click (Chrome 122+ offers a persistent permission).
- Folder identity is a workspace concern: workspace matches a newly picked handle against saved handles with `isSameEntry` and assigns a stable `WorkspaceFolderId`.
- Layout (Board: widgets + camera) is stored in IndexedDB keyed by `WorkspaceFolderId`, debounced 1 s. Restoring is one step: `restoreBoard(folderId, discoveredFiles)` loads the saved layout and runs the pure `reconcile` policy (D4), so no widget is placed before the layout is known. Rejected: a `.code-canvas.json` file in the folder — that writes into someone else's repository.
- Seams only where two adapters exist: `DirectoryReader`/`FileWriter` (File System Access + the harness mock), `Tokenizer` (worker pool + sync fake), `EditorHost` (Monaco + fake), `GpuUploader` (WebGL + recording fake). The IndexedDB stores for the folder handle and the layout have one production adapter each; they are tested against an in-memory IndexedDB (`fake-indexeddb`) rather than behind a port.
- Writing a file: immediately before the write, the file is re-read and hashed; if the hash doesn't match the known File Revision → `SaveConflict` (spec `workspace-storage`). `lastModified` + size are used only to avoid re-reading files when scanning the folder.

### D14. Security

- File paths and names are rendered to the DOM only via `textContent`; `innerHTML` in `src/` is forbidden by the linter (`no-restricted-properties`).
- The `window.__perf` bridge and the File System Access mock exist only in the build with `VITE_PERF_HARNESS=1`; a test builds the regular bundle and verifies the absence of the bridge strings and mock adapters; the regular build's composition root does not import the mock.
- The code font is the system font named in `shared/font.ts` or a file from the bundle; there are no external downloads; the page's CSP forbids third-party script and font sources; workers are module scripts from the bundle (no `blob:` workers).
- The tokenizer workers receive only the file's text and the raster workers only its cells; the grammar and theme are static, nothing from file content is ever executed.

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
- **Feeding gestures**: preferably CDP `Input.synthesizeScrollGesture` / `Input.synthesizePinchGesture` — they go through the browser's input and compositor pipeline, like a real trackpad; for drag/resize — `Input.dispatchMouseEvent`, for typing — `Input.dispatchKeyEvent`. Which CDP gestures produce, on macOS, the same DOM events as a trackpad (pinch → `wheel` + `ctrlKey`) is checked in spike A; the fallback is `Input.dispatchMouseEvent` of type `mouseWheel` with the Ctrl modifier, paced by a high-resolution Node timer. The driver uses the fallback. **Honest gestures** (spike H2): events go out at their planned times without awaiting each acknowledgement — awaiting serialized a gesture at ~45 ms per event, 5× its plan; a pinch of scale s is sent as ctrl+wheel with Σ deltaY = −100·ln s, as Chrome reports a touchpad pinch (D8). A run is an invalid measurement (exit code 2) when its gesture took more than 1.5× its planned time or its final camera differs from the planned one (scale by more than 2%, position by more than 2% of the planned displacement or 2 world px): a slower or shorter gesture than planned makes the frame numbers look better than they are.
- **Frame classification**: a CDP `Tracing` trace with DevTools timeline categories; parsing uses the same trace engine as the DevTools Performance panel, published as an npm package (`@paulirish/trace_engine`; its availability and API are checked in spike A). If it can't be used — a homegrown parser of frame events, cross-checked against the DevTools panel on the same trace (the spec's "Artifacts" requirement). There is **one** trace classifier, in `perf/harness/trace.ts`, seeded from spike C's `spikes/c/trace-analysis.mjs`: frames are `PipelineReporter` events paired by the trace engine and classified by their `frame_reporter.state` (`STATE_PRESENTED_ALL`, `STATE_PRESENTED_PARTIAL`, `STATE_DROPPED`); the tracing categories must include `cc`; a parse failure, zero frames or zero main-thread tasks is an invalid measurement (exit code 2), never a 0. Spike E's first classifier matched event names and traced without `cc`, so its "0 dropped" could not have been anything else.
- **Frame statistics**: one module defines the percentile (nearest rank), the long-interval count and "unavailable" for an empty sample; `FrameStats` (overlay) and the harness both use it through the bridge. The spikes had six percentile copies with two definitions.
- **Measurement hygiene** (spikes B–E): measure on a production build served by `vite preview`, never the dev server; load dataset text raw (`?raw` import or file read — the Vite dev server returns transpiled JavaScript for a `.ts` URL); compare colours as resolved hex, not colour ids; accept no number without opening its capture (screenshots, traces).
- **App bridge**: a build with the `VITE_PERF_HARNESS=1` flag exposes `window.__perf` — `FrameStats` by stage, GPU time via `EXT_disjoint_timer_query_webgl2` (if available), synthetic-load control for the self-test, state-preparation commands (open the reference dataset without a dialog via the File System Access mock, set the camera). In a regular build the bridge is stripped at build time. The bridge type is the single file imported by both the application (`src/performance/bridge.ts`) and the harness; the rest of `src/` is off-limits to the harness (the boundaries rule).
- **Noise floor**: before the scenarios — a run of an empty page with an rAF loop of the same duration and the same set of trace categories; the result goes into the report and into the comparison against thresholds (spec `performance-budget` "Noise floor"). A frame drop is a rare random event, so a 60 s floor of 0 does not mean a zero rate. The self-test's empty-scene case therefore does two things:
  - it allows the one-sided 95% Poisson upper bound of the floor's dropped + partially presented rate, scaled to each run's duration (0 observed per minute → 3 per minute);
  - it fails only if a majority of the measured runs exceed that allowance.

  Whether frame-budget scenarios adopt the same rule is open.
- **Task attribution**: a main-thread task is counted as an application task if its stack contains code from the app bundle (including Monaco) or it was spawned by the app's event handlers, timers, rAF, or worker messages; everything else is a browser task.
- **Repetitions**: 1 warm-up run + 5 measured runs by default (`budgets.json`), verdict based on the worst one.
- **Coverage**: `coverage.ts` reads the `#### Scenario:` headings of the "Frame budget" and "No background stalls" requirements from `openspec/specs/performance-budget/spec.md` (before the change is archived — from `openspec/changes/code-canvas/specs/`) and requires a scenario with the same name.
- **Output for agents**: stdout carries the verdict and a table (scenario × key metrics × delta to the baseline); everything else goes into `perf/results/<time>/`. Exit codes: 0 — passed, 1 — budget violation or regression, 2 — the measurement is invalid (preflight).
- `FrameStats` is the shared source for the metrics overlay and the harness; it is fed only by the FrameLoop's Frame Sample (D8), so `performance` imports no context.
- **Stage-timing mode** (`pnpm perf:stages`): the same scenarios in any Chrome, including headless, only frame stages and application tasks, exit code 3 for "not a frame measurement" — for agent iteration.
- **Baseline**: `pnpm perf:baseline` requires interactive confirmation in a TTY; without a TTY — an error, no changes.
- Running from an agent sandbox may fail to open a visible Chrome window; in that case the user runs the full run (`! pnpm perf`) and hands the agent the report path.

## Risks / Trade-offs

- Chrome/macOS stays at 60 Hz without a trigger (research, risk #1, T3 single) → spike A on day one; if confirmed — a programmatic trigger (fullscreen/resize) and a description in the reference environment; if unattainable — revisit the acceptance criterion before development begins.
- Glyph shift on the frame of entering/exiting editing (Monaco's fractional metrics, fonts that do not scale linearly) → Monaco at the base font size under a CSS transform and the Text Metrics conformance test (D6, D9); there's no frame-by-frame synchronization during panning — the camera is stationary in the editor.
- Monaco itself exceeds 8 ms on typing, model switching, or IME → minimal configuration (D9), typing/paste/model-switch scenarios in the harness; if the budget is unattainable — a stop point with the user, not a silent exclusion from the criterion.
- Text is sharp only at its raster scale; during a zoom gesture it is scaled → exact-scale re-raster in the raster workers after the gesture, old tiles kept until the replacements land; time to sharp in the harness (D6).
- TextMate tokenization (Oniguruma regexes) is 12× slower than Monarch on a cold file (spike D2) → a worker pool, visible windows first, a per-line rule-stack cache for edits, and chunks the adapter can reorder (D7); the main thread never tokenizes widget text.
- A Detail Level transition switches every widget in the same frame → the Minimap is always ready; Text is prepared from the start of a zoom-in gesture and the switch to Text waits for it; the switch is one uniform (D6); spike E measured the worst case for the Minimap.
- A re-raster burst after a zoom gesture or on entering Text → raster workers off the main thread, budgeted uploads, old tiles kept until the replacements land, the switch to Text deferred until text is ready (D6); harness scenarios "Zoom from "Fit all" to 4.0 and back" and "Worst-case text density".
- Text Tiles hold pixels, not glyphs: memory grows with the visible area (H2: 36 MiB for a 1200 × 720 view) → a fixed tile pool sized from the viewport, LRU, tile memory in the Frame Sample (D6).
- Not measured in spike H2, carried to the product harness: smooth sub-tile scroll, time to sharp, the exit-editing hold, the deferred switch to Text, missing-tile frames during a zoom-out.
- A flood of worker responses after opening a folder → `DocumentResidency`'s budgeted drain with visible files first and stale versions dropped (D7); scenario "Pan during initial load".
- One concept split across modules hides bugs in the coordination → single owners: `EditingTransition` for entering/exiting, Board for Detail Level and hit-test, LineLayout for text → rows and cells, `DocumentResidency` for text-to-GPU, `GestureTargeting` for input routing, FrameLoop (with the stage list in `app`) for tick order (D4, D7–D9).
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

- Detail Level thresholds (spike E, legibility checked on the 1:1 captures): Text → Minimap below 9 device px of on-screen line height, Minimap → Text above 11; code is readable at 11 and degraded but recognisable at 9. Configuration, revisited if the final acceptance finds otherwise.
- The noise-floor validity threshold is preliminary (`perf/ENVIRONMENT.md`): spike A measured only an idle, non-animating page; the harness self-test measures the animated floor.
- Not verified by an agent and carried to the final manual acceptance: 120 Hz with Low Power Mode, after resize and in fullscreen, a real-trackpad momentum stream (spike A); the native folder picker, permission prompts and persistent permission across reloads and restarts (spike F — its code exercises the APIs, but no dialog was answered).
- The cold-highlighting time with the worker pool (estimated 15–20 s for the Reference Dataset) and the pool size — measured by the harness.
- Multiline rule-stack changes after an edit (opening a block comment or template literal) were not measured in spike D2; the chunked Tokenizer bounds their cost per chunk, the harness scenario for typing measures it.
- The noise-floor threshold at which a measurement is declared invalid — based on the results of spike A and the first floor measurements.
- Whether frame-budget scenarios compare against the floor's statistical upper bound and a majority of runs, as the self-test's empty scene does (D13), or against the observed floor and the worst run.
- The size of the line window around the visible area and the per-frame rebuild budget (default 2 ms) — are calibrated by the harness.
- Raster-worker count and tile-pool size (start: 2 workers, slots sized from the viewport) — calibrated by the harness.
- Time to sharp after a zoom, the exit-editing hold and the lag of the deferred switch to Text — measured by the harness; no budget is set for them yet.
