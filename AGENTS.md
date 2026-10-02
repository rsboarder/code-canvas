# AGENTS.md

Instructions for AI agents writing code in this repository. Agents write the code, configs and tests; a human reviews, runs measurements on the reference machine, and makes the call at stop points.

## Product

A web canvas in Chrome (macOS, ProMotion 120 Hz): every TypeScript file in a chosen folder is a widget with syntax highlighting; pan, zoom with detail levels, drag, resize, scroll inside a widget, editing in Monaco. The main non-functional requirement is 120 frames per second in every interaction.

## Sources of truth

| What | Where |
|---|---|
| Requirements (behavior) | `openspec/changes/code-canvas/specs/*/spec.md` |
| Architecture and decisions | `openspec/changes/code-canvas/design.md` (references like D6 point to its sections) |
| Work plan | `openspec/changes/code-canvas/tasks.md` |
| Glossary | `CONTEXT.md` — name things only with these terms |
| Reference environment and noise-floor threshold | `perf/ENVIRONMENT.md` |
| Spike results | `docs/spikes/*.md` |

If code and spec disagree, the spec wins. If the spec looks wrong, do not edit it silently: stop and ask (see "Stop points").

## Commands

```
pnpm dev              run locally
pnpm check            all gates: typecheck, lint, max-lines, format:check, knip, unit
pnpm test:e2e         functional e2e (Playwright)
pnpm perf:stages      frame-stage timings — for iteration, works in a sandbox
pnpm perf             full frame measurement — reference machine only, visible Chrome window
pnpm perf:quick       quick measurement of a scenario subset
pnpm fixtures         generate the Reference Dataset
```

Capture exit codes as a separate step, not through a pipe or an `&&` chain: `pnpm check > /tmp/check.txt 2>&1; echo "EXIT=$?"`. Exit 0 does not mean the run happened — check that more than zero tests ran.

## Taking a task

1. One task from `tasks.md` at a time, in group order. Do not start a task until the tasks it depends on are done.
2. Read the spec requirements and design sections the task refers to, and `CONTEXT.md`.
3. Do only what the task says. If extra work is needed, describe it in your report; do not do it.
4. Tick the task (`- [x]`) only when its criterion is met and the gates in "Done" are green.

## Architecture — rules enforced by the linter

- Contexts `workspace`, `board`, `code-view`, `editing`: layers `domain` → `application` → `infrastructure`; the public entry point is `index.ts`. Another context is imported only through its `index.ts`.
- `domain` is plain TypeScript: no DOM, WebGL, Monaco, or async I/O.
- Only `src/app` (the composition root) wires in context infrastructure.
- `monaco-editor` only in `editing/infrastructure` and `code-view/infrastructure`; `twgl.js` and WebGL only in `rendering`.
- `perf/` sees only `src/performance/bridge.ts` from `src/`.
- No import cycles. File ≤ 800 lines, function ≤ 80 lines, complexity ≤ 15.
- `innerHTML`/`outerHTML` are forbidden; text from files and paths is rendered only through `textContent`.

Do not disable rules (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`) or loosen the linter config or `tsconfig` without explicit human permission. Do not skip hooks (`--no-verify`).

## Performance — hot-path rules

The hot path is everything that runs every frame or on every input event: `rendering/`, `interaction/`, and the pan/zoom/drag/resize/scroll commands in `board/application`.

- During pan and zoom only the camera changes. If a change makes a frame do work proportional to the number of widgets or glyphs, that is a design error — stop.
- No allocations per widget, glyph, or input event: reuse objects and typed arrays.
- Rendering reads only projections (`WidgetTable`, buffers), never domain objects, and pulls per-frame state (Camera, Detail Level, dirty widget ids) once per tick. The event bus carries only low-frequency events between contexts; never put per-frame traffic on it (D2, D5).
- All GPU-data work (line-window rebuilds, tokens, minimaps, raster jobs and tile uploads) goes through `DocumentResidency.drain(budget, uploader)` (D7, D8), never directly from an event handler. The only work allowed outside the budget is the `EditingTransition` frame swap and the prioritized widget's line window and tile uploads, both bounded to one widget (D9).
- Tokenization and minimap building happen only in the tokenizer workers, tile rasterization only in the raster workers. A tokenizer result for a stale Content Version is discarded inside `DocumentResidency` before anything reaches the GPU (D7); a tile rasterized from a stale Content Version or raster scale is closed by the uploader adapter, never uploaded (D6).
- Each concept has one owner; do not re-implement its logic elsewhere: entering/exiting editing → `EditingTransition`; Detail Level and hit-test → Board; text → rows and cells (line splitting, tabs, character width, columns) → LineLayout; text-to-GPU ordering and staleness → `DocumentResidency`; Text Tiles (planning, rasterization, the tile pool) → the `rendering` `GpuUploader` adapter; what a gesture does → `GestureTargeting`; frame stage order → the stage list in `app`, run by `FrameLoop`.
- No `readPixels`, synchronous GPU queries, or texture re-creation inside a frame; update buffers and textures partially.
- Optimize only from measurements: first `perf:stages` or a trace, then one change, then measure again. Revert a change that shows no measurable gain.
- Forbidden: Chrome flags that disable vsync or the frame-rate limit; editing thresholds in `perf/budgets.json`; updating `perf/baseline.json` — only a human does that.

## Tests

- Test behavior (state, flag, the fact of a call, pixels), not message text.
- Domain and application layer — Vitest; spec scenarios — Playwright e2e; frame-budget scenarios — the `perf/` harness.
- Test a module through its interface. Ports exist only where two adapters exist (`DirectoryReader`/`FileWriter`, `Tokenizer`, `EditorHost`, `GpuUploader`); use their fakes. IndexedDB stores are tested against `fake-indexeddb`, not behind a new port.
- An e2e test or harness scenario is named exactly like the `#### Scenario:` in the spec.
- A failing test is a specification of missing behavior. Do not weaken the assertion to make it pass.

## Done

A task is done when:
1. `pnpm check` is green and e2e for the affected scenarios are green.
2. For tasks touching rendering, input, the frame loop, or background work: `pnpm perf:stages` is green while iterating, and the task closes only with a green full `pnpm perf` on the reference machine and that run's report path in the task report. If you cannot run the full measurement, ask the human to run `pnpm perf` and attach the report path they give you.
3. The task report contains: what was done; gate output (exit code, test count); the harness report path if required; what remains unverified — stated plainly, without softening.

## Measurement cadence

- While changes to rendering, input, the frame loop or background work are landing, the full `pnpm perf` runs on the reference machine at least twice a day, not only when a task closes.
- Once a week the human records a DevTools trace of real trackpad gestures on the reference machine — pan, pinch, and scroll inside a widget — and commits it as `perf/acceptance/weekly/<YYYY-MM-DD>-<gesture>.json.gz`. Its dropped and partially presented frames are compared with the latest full harness report of the matching scenario. If the real trace is worse, the harness gestures miss something real input does: record the difference in `perf/ENVIRONMENT.md` and treat the harness verdicts for that gesture as unconfirmed until a harness scenario reproduces it.

## Stop points — stop and ask the human

- A spike result contradicts a decision in design.md (for example, Monarch does not run in a worker, or 120 Hz is unreachable).
- The vertical slice misses the frame budget even with a single widget.
- The frame budget cannot be met with honest optimizations and a lever that degrades the picture is needed (earlier switch to the minimap, lower resolution during a gesture, etc.).
- Monaco on its own exceeds the task budget.
- A spec requirement contradicts another requirement or turns out to be infeasible.
- A new dependency is needed that design.md does not mention.

## Git

- Small commits; one task — one or more commits; conventional commits (`feat(board): …`, `perf(rendering): …`).
- Do not commit `perf/results/`. Acceptance traces (`perf/acceptance/`) are committed compressed (`.json.gz`).
- Do not change `openspec/` or `CONTEXT.md` unless the human asks. The one exception is task 2.8: record spike verdicts, thresholds and open questions in `design.md`, and if a verdict changes the approach, stop before editing. Propose new terms in your report.
