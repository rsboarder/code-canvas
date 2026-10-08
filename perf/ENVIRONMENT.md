# Reference environment

The frame criterion (spec `performance-budget`) is judged only here. The harness preflight (design D13) records each item below into every report and refuses a run that violates it.

| Item | Value |
|---|---|
| Machine | MacBook Pro with the built-in ProMotion display (120 Hz), DPR 2 |
| Power | Low Power Mode off (it caps the display at 60 Hz; the idle frame rate preflight catches it). AC power is not required (user's decision, 2026-10-04); the power source is recorded in the report |
| Browser | Google Chrome stable (154.0.8037.58 on 2026-09-29; the preflight records the exact version), launched by Playwright with `channel: "chrome"`, headed, no vsync or frame-rate flags |
| Profile | a clean temporary profile created by Playwright for each run: no extensions, no signed-in account, no restored tabs |
| Window | visible, covering the built-in display; the harness moves its window onto the built-in display itself, so another monitor may stay the main display; the machine is otherwise idle and the screen unlocked (a locked screen suppresses presentation) |
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

**Preliminary validity threshold** (set 2026-09-29; to confirm once the harness has measured the animated floor over several sessions): a measurement is invalid (exit code 2) if the same-session floor exceeds **3 dropped or 3 partially presented frames per minute, or any interval > 12.5 ms per minute on the idle rAF sample**. A scenario passes against the floor as spec `performance-budget` "Noise floor" states.

## DevTools panel cross-check (task 4.12, 2026-10-06)

Trace `perf/results/2026-10-06T12-21-08-447Z-full/typing-5.json.gz` (headed "Typing", Chrome 154.0.8037.98; results
are not committed). The harness report counts 2 partially presented and 1 dropped frame in it. The human loaded the
trace into the DevTools Performance panel with the three frames marked as annotations: the panel shows a dropped frame
of 0.3 ms after the second keystroke (≈105 ms), a partially presented frame of 7.5 ms after the seventh (≈605 ms) and
one of 8.2 ms after the first double click (≈1971 ms), the same frames with the same types. The panel's frame model
(`trace_engine` `Frames`) has no other dropped or partially presented frame in the trace, and none of the harness's
wake-up frames is marked bad. The counts match.

## Not verified by an agent

- Behaviour with Low Power Mode on is out of scope (user's decision, 2026-10-06); window resize and fullscreen hold 120 Hz (spike A, "Window states", 2026-10-04).
- Fast gestures. A real trackpad (spike A "Real trackpad", 2026-10-06) sends the same `wheel` events as the harness (`ctrlKey` for pinch, no gesture events) but pans at 3000–18 000 px/s with a 0.7–1.4 s momentum tail and pinches ≈2–3× faster than the harness scenarios (pan ≤ 400 px/s, no tail). Harness verdicts for pan and zoom are therefore unconfirmed for real gestures until the real-gesture traces of task 13.2.
