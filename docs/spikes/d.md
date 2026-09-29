# Spike D — Monarch TypeScript tokenization in a Web Worker

## Question

Can Monaco's Monarch TypeScript grammar run in a Web Worker without Monaco's DOM/editor part, while producing the same `vs-dark` token colors as Monaco on the main thread? What are the worker timings for a 2000-line file and the full Reference Dataset, what is the main-thread receive cost for structured clone versus transferables, and how large is an R8 minimap?

## Method

The page at `spikes/d/index.html` creates a module Worker whose direct imports use Monaco's 0.57 exports-map form (without `esm/vs/`):

1. `monaco-editor/editor/standalone/common/monarch/monarchCompile.js`
2. `monaco-editor/editor/standalone/common/monarch/monarchLexer.js`
3. `monaco-editor/languages/definitions/typescript/typescript.js`

The worker compiles the TypeScript Monarch language definition once, tokenizes each line while carrying Monarch state across lines, expands token runs into the Monaco theme's foreground color ids, and builds a fixed-width minimap immediately afterward. The result includes `(fileId, contentVersion)`, a `Uint32Array` of per-UTF-16-character foreground ids, line offsets, and a `Uint8Array` of R8 palette indices. Transfer mode sends all three buffers in the transfer list; clone mode sends the same object without a transfer list. Dataset files are loaded with `import.meta.glob("/fixtures/reference-dataset/**/*.{ts,tsx}", { query: "?raw", import: "default" })`, so Vite treats them as raw strings rather than TypeScript modules.

The main thread uses the real Monaco model tokenizer with the same TypeScript language definition and `vs-dark` built-in token theme. It compares every character's foreground id for all 200 files. The receive metric is the message-handler time while checksumming the received arrays; browser-side structured-clone/transfer deserialization itself must be confirmed in a Chrome trace because it occurs before JavaScript handler entry.

Minimap proposal: width 256 texels, one row per source line up to 512 rows. Longer files decimate with `sourceLine = floor(row * lineCount / height)`. Each column covers the proportional source-character range and takes the first non-whitespace token color; empty columns remain palette index 0. This gives `256 × min(lineCount, 512)` bytes per file.

## Environment

The automated harness is `spikes/d/measure.ts`. It builds the spike page with Vite into a temporary directory outside the repository, serves that directory with Vite preview on a strict free `127.0.0.1` port, launches Playwright with `channel: "chrome"` and a visible window, opens the preview root, and prints one JSON summary. Timing measurements belong on this production build. The Reference Dataset must already exist at `fixtures/reference-dataset/` (the lead runs `pnpm fixtures`).

The reference MacBook, Chrome version, display refresh rate, power state, and exact run date were not available in this sandbox.

Round 5 note: the production-root dataset glob uses `../../fixtures/reference-dataset/**/*.{ts,tsx}`, normalizes keys back to `/fixtures/reference-dataset/...`, and asserts exactly 200 entries before measurement.

Lead run environment (2026-09-28): production build, Playwright headed Chrome 154, DPR 1, one worker.

### Environment/finding

`monaco-editor` 0.57 exposes deep modules through its package exports map. Specifiers must omit `esm/vs/`: `monaco-editor/editor/editor.api.js`, `monaco-editor/editor/standalone/common/monarch/monarchCompile.js`, `monaco-editor/editor/standalone/common/monarch/monarchLexer.js`, and `monaco-editor/languages/definitions/typescript/typescript.js` resolve to files under `node_modules/monaco-editor/esm/vs/`. Using the physical `monaco-editor/esm/vs/...` path causes the resolver to look for `esm/vs/esm/vs/...` and fail before `window.__spikeRun` is installed.

The lead's headed reference run reproduced that failure as `Failed to resolve import "monaco-editor/esm/vs/editor/editor.api.js" from "spikes/d/main.ts"`, followed by `window.__spikeRun is not a function`. This rework changes all spike specifiers to the exports-map form; the worker still has no `editor.api.js` import.

## D7 import-shape finding

The Worker construction is already the Vite-supported form: `new Worker(new URL("./tokenizer.worker.ts", import.meta.url), { type: "module" })`. The remaining `/@vite/client` contamination comes from the worker import graph:

`tokenizer.worker.ts` → `languages/definitions/typescript/typescript.js` → `editor/editor.api.js` → `editor/standalone/browser/standaloneEditor.js` → `./standalone-tokens.css` → Vite's `/@vite/client` HMR module.

Monaco 0.57's TypeScript definition imports `editor/editor.api.js` only to read `languages.IndentAction.IndentOutdent` and `languages.IndentAction.None` in its editor configuration. The worker-only Vite plugin resolves that relative import from `languages/definitions/**` to `spikes/d/editor-api-shim.ts`, whose numeric values match `editor/common/languages/languageConfiguration.js:8-28`. The main thread remains on the real Monaco API for the color comparison. No main-thread fallback tokenizer was added.

## 2.8 product decision — dev-mode worker resolution

The spike measures production output only. Dev mode remains out of scope because Vite's dependency optimizer can pre-bundle `monaco-editor/languages/definitions/typescript/typescript.js` before the worker-only build plugin runs, restoring the DOM/editor import chain. For 2.8, choose either `optimizeDeps.exclude` for the Monaco language definitions plus a main-pipeline resolve rule, or a vendored grammar. Do not add a dev-mode hack to this spike.

## Production worker chunk

Command used (temporary output outside the repository; the explicit config path is required because the spike root is nested):

```sh
node --input-type=module -e 'import { build } from "vite"; const outDir = process.argv[1]; await build({ root: "/private/tmp/codex-wt-spike-d/spikes/d", configFile: "/private/tmp/codex-wt-spike-d/vite.config.ts", build: { outDir, emptyOutDir: true, sourcemap: true } });' "/private/tmp/spike-d-page-final-shim.l0HgYV"
```

The production Worker asset was `assets/tokenizer.worker-BPc_WIc0.js`, 117,423 bytes. Its source map lists 26 Monaco modules:

- `base/common/errors.js`, `base/common/types.js`, `base/common/cache.js`, `base/common/lazy.js`, `base/common/strings.js`
- `editor/standalone/common/monarch/monarchCommon.js`, `editor/standalone/common/monarch/monarchCompile.js`, `editor/standalone/common/monarch/monarchLexer.js`
- `base/common/iterator.js`, `base/common/lifecycle.js`, `base/common/codiconsUtil.js`, `base/common/codiconsLibrary.js`, `base/common/codicons.js`, `nls.js`, `base/common/platform.js`, `base/common/process.js`, `base/common/path.js`, `base/common/linkedList.js`, `base/common/stopwatch.js`, `base/common/event.js`
- `editor/common/tokenizationRegistry.js`, `editor/common/languages.js`, `editor/common/languages/nullTokenize.js`
- `platform/instantiation/common/instantiation.js`, `platform/configuration/common/configuration.js`
- `languages/definitions/typescript/typescript.js`

The module inventory was obtained from `tokenizer.worker-*.js.map` with `map.sources.filter(source => source.includes("monaco-editor"))`; the byte size was obtained from the Worker asset size (`wc -c` equivalent). The same source-map scan found no `editor/editor.api.js`, no `editor/standalone/browser/*`, no `base/browser/*`, and no `.css` modules.

The local attempt to run `pnpm exec tsx spikes/d/measure.ts` was blocked before the harness started: `tsx` could not listen on `.cdx-tmp/tsx-502/52789.pipe` (`EPERM`). Running the same harness with `node --import tsx/esm` completed the production build and printed `[spike-d] production build done`, but Vite preview could not bind `127.0.0.1` (`EPERM`). No local Chrome result is being substituted for the reference run.

## Results

The values below come from the lead's production runs.

| Metric | Result |
| --- | --- |
| Worker can evaluate Monarch without a DOM failure | yes — the lead's production run received worker results before the main-thread comparison failed |
| Worker bundle size | 117,423 bytes for `tokenizer.worker-BPc_WIc0.js`; source map lists 26 Monaco modules |
| Exact worker direct imports | `monacoCompile.js`, `monarchLexer.js`, `typescript.js` (listed above) |
| 2000-line per-file worker timing: median | 31.7 ms (current lead run); previous 30.6 ms |
| 2000-line per-file worker timing: p95 | 34.6 ms (current lead run); previous 32.4 ms |
| 2000-line per-file worker timing: max | 48.0 ms (current lead run); previous 38.0 ms |
| Whole Reference Dataset worker timing | 5,524.8 ms for 200 files / 400,000 lines (current lead run); previous 5,263.9 ms |
| Color mismatches across all 200 files | 0 mismatches over 55,740,464 characters compared |
| Main-thread receive: structured clone | median 0.1 ms, max 0.4 ms (lead run) |
| Main-thread receive: transferables | median 0.0 ms, max 0.1 ms (lead run) |
| Minimap width | 256 texels |
| Minimap height/decimation | `min(lines, 512)` rows with proportional source-line sampling |
| Minimap bytes per 2000-line file | 131,072 B (R8) |
| Minimap bytes for 200 files | 26,214,400 B (R8) |
| Worker bundle's transitive DOM/editor imports | none found in the production source map: no `editor/editor.api.js`, `editor/standalone/browser/*`, `base/browser/*`, or `.css` modules |

## Gate status

- `pnpm check`: exit 0. Typecheck, lint, max-lines, format, knip, and unit tests passed; 3 test files and 20 tests passed.
- No test file was added, so a file-specific `pnpm jest <file>` run was not applicable.
- Harness report path: none; the local `tsx`/Chrome harness was unavailable as described above. The lead must run it on the reference machine.

## Manual steps

1. On the reference MacBook, connect AC power, use the agreed full-screen built-in 120 Hz display, disable Low Power Mode, and use a clean stable Chrome profile with no frame-rate/vsync flags.
2. Run `pnpm fixtures` from this worktree.
3. Run `pnpm tsx spikes/d/measure.ts`; the harness builds and previews the production page, and keep the visible Chrome window open while it runs.
4. If the Worker errors, copy the exact status text and browser console error, including the failing module and error message. Do not add a main-thread fallback.
5. If the run succeeds, click “Copy results as JSON” and attach the JSON output to this report, including the reported mismatch count and all timing summaries.
6. Inspect the worker bundle/module graph and asset size to confirm whether `editor.api.js`, `standaloneEditor.js`, browser DOM modules, or CSS entered the worker. Record the exact module paths and byte size.

## Verdict

works: Monarch TypeScript tokenization runs in a Worker (production build) with a worker-only editor.api shim; colours match Monaco byte for byte on the whole Reference Dataset

Not proven:

- dev-mode path — product decision for 2.8
- `.tsx` files are tokenized with the `typescript` Monarch grammar on both sides, same as Monaco's default
- trace separation of structured-clone deserialisation
- The unexplained single 404 (URL not captured by the response listener — likely `/favicon.ico`) is unverified.

## Proposed design impact

The product tokenizer Worker needs this worker-only resolution rule, or an equivalent vendored grammar, so the TypeScript definition does not pull Monaco's editor/browser modules into the Worker. Every `monaco-editor` deep import must use the exports-map form without `esm/vs/`. The main thread must not become the fallback because that would violate the no-background-stalls requirement. D6's 256×512 R8 minimap remains a provisional proposal pending Spike E.

## Open questions

- Does the worker-only shim preserve byte-for-byte foreground color agreement with Monaco in the reference Chrome run?
- Does the reference Chrome worker report the same foreground ids as Monaco for every Reference Dataset character, including TSX, multiline templates, comments, tabs, and non-ASCII text?
- Should Spike E replace the provisional 256×512 minimap dimensions or decimation rule?
- A trace is still needed to separate browser deserialization time from the JavaScript receive-handler time reported by the page.
