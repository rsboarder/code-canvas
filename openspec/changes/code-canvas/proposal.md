## Why

We need a web canvas that lets you view and edit ~200 TypeScript files with syntax highlighting at the same time, and that holds 120fps while zooming, panning, and switching detail levels. Smoothness must be confirmed by measurement in Chrome DevTools, not by feel. Timeline: 2–4 weeks.

## What Changes

- A new web product (from scratch, empty repository): an infinite canvas in Chrome where every TypeScript file from a chosen local folder is shown as a separate widget.
- Canvas pan and zoom (trackpad, mouse), with widgets laid out in a simple grid on first open.
- Code rendering with syntax highlighting via a custom GPU renderer for all inactive widgets; detail levels: text up close, a line minimap and a large file name farther away.
- Scrolling inside a widget, dragging widgets, and resizing widgets.
- Editing: one active Monaco editor opened by double-click; zooming out exits editing mode while preserving edits.
- Working with a local folder via the File System Access API: reading files, writing edits back to disk, and persisting widget positions and sizes across sessions.
- A performance harness: a single command plays back declarative scenarios for all interactions in Chrome on the reference machine, validates the environment, collects frame metrics from the browser trace, compares them against the budget and the baseline, and can prove that it actually detects stalls. Every task is checked with it; final acceptance is manual, with real gestures and DevTools traces.

## Capabilities

### New Capabilities
- `canvas-viewport`: canvas pan and zoom, initial grid layout, widget visibility/culling, camera persistence.
- `code-widget-rendering`: code rendering with highlighting in inactive widgets, detail levels (text ↔ minimap + file name), scrolling inside a widget.
- `widget-manipulation`: dragging and resizing widgets.
- `code-editing`: active Monaco editor, entering/exiting editing, saving edits.
- `workspace-storage`: opening a local folder, selecting TS files, writing edits to disk, persisting layout.
- `performance-budget`: frame targets (120fps) for all interactions, reference environment, manual acceptance.
- `performance-harness`: automatic frame budget verification tool for developers and agents.

### Modified Capabilities
<!-- none: no existing specs -->

## Impact

- Code: new repository (TypeScript, frontend only, no backend). Architectural rules and limits are enforced by linters.
- Dependencies: `monaco-editor` (user's decision); others (rendering, tokenizer) are chosen in design.md based on the findings of `docs/research-code-canvas.md`.
- Platform: Chrome on macOS only (File System Access API, 120Hz ProMotion). Safari and Firefox are out of scope.
- Delivery: no deployment; the deliverable is a link to the repository with run instructions.
