# Reference environment

The frame criterion (spec `performance-budget`) is judged only here. The harness preflight (design D13) records each item below into every report and refuses a run that violates it.

| Item | Value |
|---|---|
| Machine | MacBook Pro with the built-in ProMotion display (120 Hz), DPR 2 |
| Power | AC power attached; Low Power Mode off (it caps the display at 60 Hz; not measured by an agent — `pmset` shows the state, the preflight checks it) |
| Browser | Google Chrome stable, launched by Playwright with `channel: "chrome"`, headed, no vsync or frame-rate flags |
| Window | visible, covering the built-in display; the machine is otherwise idle and the screen unlocked (a locked screen suppresses presentation) |
| Build | production build served by `vite preview`, never the dev server |

## Idle rate (spike A, 2026-09-29, 60 s)

rAF on an idle page: 120.48 Hz, interval p50/p95/p99 8.3/9.8/10.2 ms, 0 intervals > 12.5 ms per minute (1,201 samples). An earlier run the day before gave 8.3/9.2/9.3 ms and 0.

## Noise floor

Classified with `@paulirish/trace_engine` (`PipelineReporter` state), the same engine as the DevTools Performance panel.

| Measurement | Dropped / min | Partially presented / min | Source |
|---|---:|---:|---|
| Idle page, nothing animating, 60 s trace | 2 (0 the day before) | 0 | spike A |
| Densest scene, zoom sweep (not a floor, for scale) | 1 of 701 frames | 0 | spike E |

The spike A trace does not animate (243 presented frames per minute), so it is the floor of an idle page, not of a page redrawing every frame as design D13 defines it. The harness self-test measures that floor before every scenario.

**Preliminary validity threshold** (to confirm once the harness has measured the animated floor over several sessions): a measurement is invalid (exit code 2) if the same-session floor exceeds **3 dropped or 3 partially presented frames per minute, or any interval > 12.5 ms per minute on the idle rAF sample**. A scenario passes against the floor as spec `performance-budget` "Noise floor" states.

## Not verified by an agent

- Behaviour with Low Power Mode on, after a window resize and in fullscreen (spike A manual steps 3–4).
- The DevTools panel's frame count on the same trace. The harness uses the panel's own engine (`trace_engine`), so a mismatch would come from categories, not classification; the weekly manual trace (design D13, "Risks") covers it.
- A real-trackpad event stream: CDP scroll gives `wheel` without `ctrlKey`, CDP pinch gives `wheel` with `ctrlKey`, neither produces an inertia tail. The final acceptance with real gestures (spec `performance-budget`) covers momentum.
