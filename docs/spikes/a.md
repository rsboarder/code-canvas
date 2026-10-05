# Spike A — Chrome frame timing and input harness

## Question

Can the reference MacBook sustain the 120 Hz requirement for an unloaded page and after a
window resize/fullscreen transition, with Low Power Mode on and off? Can the planned performance
harness launch visible Chrome, feed gestures through CDP, classify frames with the same engine as
DevTools, and attribute application tasks separately from browser work?

## Method

`spikes/a/index.html` is an unloaded Vite page with a ring-buffered `requestAnimationFrame` log.
It shows p50/p95/p99 frame intervals, an estimated refresh rate, and intervals over 12.5 ms in the
last minute. It also records wheel (including `ctrlKey` pinch), pointer, and Safari gesture events
with timestamps and input fields, and exposes a JSON-copy control and a small deliberate 10 ms
busy-loop toggle for attribution testing.

`spikes/a/measure.ts` starts its own Vite server, launches system Chrome through Playwright with
`channel: "chrome"`, records an idle interval sample, records a DevTools-compatible CDP trace,
feeds `Input.synthesizeScrollGesture` and `Input.synthesizePinchGesture`, waits for a possible
momentum tail, and saves compressed raw traces in `spikes/a/results/`. It parses the noise-floor
trace with the trace engine model and pairs modern Chrome `PipelineReporter` events with the
trace-engine helper:
the installed `@paulirish/trace_engine` package:

```text
TraceModel.Model.createWithAllHandlers().parse(events)
Helpers.Trace.createMatchedSortedSyntheticEvents(pipelineReporterEvents)
```

The legacy `parsed.data.Frames.frames` result is empty for this modern Chrome trace even though
the categories and metadata are present. The paired `PipelineReporter` records are the non-zero
trace-engine result used by the spike. `measure.ts` now emits `[spike-a] ...` progress lines and
one final JSON summary line.

Task attribution is demonstrated on the same trace with a 10 ms busy loop every second. Main-thread
`RunTask`, `Task`, `FunctionCall`, and `EvaluateScript` records are application work when their
stack/script details contain the page origin or `/spikes/a/`; compositor, GPU, and unrelated
`v8.run` records remain browser work. This is a proposal for the eventual harness attribution,
not a replacement for a DevTools-panel comparison.

## Environment

The source files and automated runner were prepared in the agent sandbox. The lead's valid run was
2026-09-28 on Playwright headed Chrome 154, not fullscreen; power state and Low Power Mode were
unknown. The runner intentionally adds no launch flags that disable vsync or frame-rate limiting.

## Verification

`pnpm check` passed with exit code 0: typecheck, lint, max-lines, format check, knip, and 20 tests
across 3 test files. The trace-engine Node import was also verified directly. The saved traces were
analyzed offline by `node spikes/a/analyze-traces.mjs`.

## Measurements

Run `tsx spikes/a/measure.ts` from the worktree on the reference MacBook. Override duration while
iterating with `SPIKE_IDLE_SECONDS`, `SPIKE_TRACE_SECONDS`, `SPIKE_ATTRIBUTION_SECONDS`, and
`SPIKE_SKIP_TRACE=1`. The runner prints a JSON summary and writes
`spikes/a/results/idle-noise-floor.json.gz` plus
`spikes/a/results/attribution-busy-loop.json.gz`.

| Metric | Result | Status / source |
|---|---:|---|
| Idle rAF p50 interval | 8.3 ms | lead's 60 s reference run |
| Idle rAF p95 interval | 9.2 ms | lead's 60 s reference run |
| Idle rAF p99 interval | 9.3 ms | lead's 60 s reference run |
| Estimated idle refresh rate | 120.48 Hz | lead's 60 s reference run; 1200 samples |
| Intervals > 12.5 ms per minute | 0 | lead's 60 s reference run |
| Trace-engine paired frames | 7202 | offline `PipelineReporter` pairing with trace-engine helper |
| Trace presented frames | 241 | offline idle trace classification |
| Trace partially presented frames | 0 | offline idle trace classification |
| Trace dropped frames | 0 | offline idle trace classification |
| Trace intervals > 12.5 ms | 1 | offline idle trace; paired frame timestamps |
| Chrome visible launch from Playwright | passed | lead's headed `channel: "chrome"` run |
| Chrome visible launch from the agent sandbox | unavailable — sandbox cannot launch visible Chrome | known environment limitation |
| CDP scroll DOM event types/deltas | 91 `wheel`, `ctrlKey=false`, `deltaMode=0` | lead's headed run |
| CDP scroll inertia phase | no inertia tail; 0 events | lead's headed run |
| CDP pinch DOM event types/deltas | 12 `wheel`, `ctrlKey=true`; no Safari gesture events | lead's headed run |
| CDP pinch inertia phase | no inertia tail; 0 events | lead's headed run |
| Trace engine API works in Node | measured — API is importable and wired in `measure.ts` | installed package API |
| Trace engine vs DevTools frame-count match | not measured — needs human to open the saved trace in DevTools | same `.json.gz` trace |
| Application tasks | 50 | lead's attribution trace |
| Longest application task | 10.184 ms | lead's attribution trace; deliberate 10 ms busy loop |
| Browser tasks | 4760 before parent correction; 4707 leaf tasks after correction | lead result and offline corrected attribution |
| Longest browser task | 1.494 ms | offline corrected attribution; 50 parent `RunTask`s excluded |
| Resize/fullscreen before and after | 120.0 Hz, p99 9.3 ms, 0 intervals > 12.5 ms in every state | 2026-10-04 headed run, see "Window states" below |
| Low Power Mode off/on | not measured — needs manual reference-MacBook run | manual checklist |

## Window states (2026-10-04)

Headed Chrome 154.0.8037.97 from Playwright (`channel: "chrome"`), built-in display, DPR 2, screen 1800 × 1169 CSS px,
AC power, Low Power Mode off. An unloaded page logged `requestAnimationFrame` intervals for 10 s in each window state,
after a 2 s settle (4 s after entering fullscreen); the state was set through CDP `Browser.setWindowBounds` in the order
of the table, so each row is also "after" the previous transition.

| Window state | Viewport (CSS px) | Samples | p50 ms | p95 ms | p99 ms | max ms | Rate Hz | > 12.5 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Normal 1200 × 800 | 1200 × 713 | 1200 | 8.3 | 9.2 | 9.3 | 9.5 | 120.00 | 0 |
| Resized to 800 × 600 | 800 × 513 | 1200 | 8.3 | 9.3 | 9.4 | 9.4 | 120.00 | 0 |
| Resized to 1600 × 1000 | 1600 × 913 | 1201 | 8.3 | 9.2 | 9.3 | 9.4 | 120.00 | 0 |
| Maximized | 1800 × 986 | 1201 | 8.3 | 9.2 | 9.3 | 9.4 | 120.00 | 0 |
| Fullscreen | 1800 × 1042 | 1200 | 8.3 | 9.1 | 9.3 | 9.4 | 120.00 | 0 |
| After leaving fullscreen (macOS restores maximized) | 1800 × 986 | 1200 | 8.3 | 9.2 | 9.3 | 9.4 | 119.99 | 0 |

No window state or transition needs a trigger to reach 120 Hz. Low Power Mode on was not measured: switching it needs
the human.

## Manual steps

1. On AC power, open `/spikes/a/` in the reference stable Chrome profile with no extensions.
2. Start the frame log and leave the blank page idle for 10 seconds; record p50, p95, p99,
   estimated refresh, and intervals over 12.5 ms.
3. Repeat after resizing the visible window, then repeat in fullscreen. Record each condition
   separately; restore the same window/fullscreen state before comparing.
4. Repeat steps 2–3 with Low Power Mode off and on. Record the power state and the exact Chrome
   version, machine model, display refresh rate, DPR, and window size.
5. In DevTools Performance, record the same blank page for the same duration with the same trace
   categories. Save the trace and compare presented, partially presented, dropped, and long-frame
   counts with the runner output.
6. Start the page input recorder, perform a real-trackpad pan and pinch, click “Copy input results
   as JSON”, and preserve the JSON with the report. Compare event types, `ctrlKey`, deltas,
   timestamps, and the momentum tail with the CDP results.
7. Run `tsx spikes/a/measure.ts` headed on the reference machine. Keep the generated compressed
   trace so the DevTools panel can be checked against the trace-engine counts.

## Verdict

**Pending human acceptance items.** The lead's idle run reached 120.48 Hz with no long rAF
intervals, so 120 Hz is attainable in the stated non-fullscreen Chrome 154 condition. Window resizes,
maximized and fullscreen, and leaving fullscreen all hold 120 Hz with no trigger (2026-10-04, "Window
states"). Low Power Mode, a DevTools-panel comparison, and real-trackpad behavior remain unverified; no
trigger or criterion revision is justified until those measurements are recorded.

## Proposed design impact

If the idle rate is at least 115 Hz and the same-session noise floor is within the agreed threshold,
keep D13's headed visible Chrome preflight and retain the 120 Hz criterion. If the page remains at
60 Hz until a resize/fullscreen trigger, document that trigger in the reference environment and
make it part of preflight. If 120 Hz remains unattainable on AC and in fullscreen, stop before
changing D13 or the frame criterion and ask the human to revise the acceptance decision.

The CDP event stream should remain a regression driver only. Manual real-trackpad acceptance stays
the final input criterion until its DOM event and inertia behavior agrees with CDP. The trace engine
should be used in Node as above, with one saved trace opened in DevTools as the required cross-check.

## Open questions

- What exact noise-floor threshold will the human accept for dropped, partially presented, and long
  intervals per minute?
- Does macOS `synthesizeScrollGesture` produce the same wheel event sequence and momentum tail as
  a recorded trackpad pan on the reference Chrome build?
- Does macOS `synthesizePinchGesture` produce `wheel` + `ctrlKey`, Safari gesture events, or both?
- Does the trace-engine `PipelineReporter` pairing count exactly match DevTools for the saved trace?
- Which stack field is consistently present for application tasks in the reference Chrome trace,
  and does the attribution rule need source-map or bundle-URL normalization?
