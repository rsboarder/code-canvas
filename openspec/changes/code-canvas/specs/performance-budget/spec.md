## Purpose

Fixes a measurable smoothness criterion — 120 frames per second across all interactions — and the environment in which it is verified. The verification tool is described in the `performance-harness` capability.

## ADDED Requirements

### Requirement: Reference environment
Target metrics SHALL be verified in a reference environment, fixed in the repository before the start of core development:
- a MacBook Pro with a built-in 120 Hz ProMotion display;
- current stable Chrome with no command-line flags affecting frame rate or vsync;
- the browser window full-screen on the built-in display, running on AC power;
- a reference dataset — 200 TypeScript/TSX files of 2000 lines each (the worst case for the target), with dense tokenization, lines up to 300 characters, and all major language constructs, generated deterministically.

#### Scenario: Dataset reproducibility
- **WHEN** a developer runs the reference dataset preparation command
- **THEN** the same folder of 200 files of 2000 lines each, with identical content, is created on every run

#### Scenario: Environment documented in the repository
- **WHEN** a developer opens the repository
- **THEN** they find a description of the reference environment (machine model, Chrome version, display refresh rate, run conditions) and the date the environment was agreed on

### Requirement: Frame budget
During each of the interactions — pan, zoom (including detail-level transitions), dragging a widget, resizing a widget, scrolling inside a widget, typing in the editor — the system SHALL, in the reference environment, sustain:
- the number of frames with Dropped and Partially presented status in a Chrome DevTools Performance trace does not exceed the noise floor (the "Noise floor" requirement) scaled to the same duration;
- the number of intervals between presented frames longer than 12.5 ms (1.5 frame periods at 120 Hz) does not exceed the noise floor scaled to the same duration;
- no main-thread task caused by the application code or its libraries (including the editor) lasts longer than 8 ms; browser tasks not caused by application code are excluded from this criterion but are reflected in the report.

#### Scenario: Pan across the whole canvas at zoom 1.0
- **WHEN** a trace is recorded in the reference environment during a continuous pan across the entire grid of 200 widgets at zoom 1.0
- **THEN** the trace contains no dropped or partially presented frames

#### Scenario: Zoom from "Fit all" to 4.0 and back
- **WHEN** a trace is recorded during a continuous zoom from a view of all 200 widgets to zoom 4.0 and back
- **THEN** the trace contains no dropped frames, including at detail-level transitions

#### Scenario: Worst-case text density
- **WHEN** the zoom level is chosen so that the maximum number of widgets still shown at the "Text" detail level fit on screen, and a pan is performed
- **THEN** the trace contains no dropped frames

#### Scenario: Drag, resize and scroll inside a widget
- **WHEN** a trace is recorded during each of these interactions at zoom 1.0 on a densely populated screen
- **THEN** the trace contains no dropped frames

#### Scenario: Typing
- **WHEN** a trace is recorded while typing in the editor of a 2000-line file
- **THEN** the trace contains no dropped frames

### Requirement: Noise floor
The noise floor SHALL be measured in the reference environment using the same trace-recording method, on a blank page with a continuous unloaded `requestAnimationFrame` loop, for the same duration as the scenarios, and expressed as the number of Dropped and Partially presented frames and intervals longer than 12.5 ms per minute. Because these are rare random events, a floor of zero over a minute does not mean a zero rate: a trace is compared against the one-sided 95% Poisson upper bound of the floor's rate, and the harness judges a scenario across its repeated runs (spec `performance-harness`). The floor measurement SHALL be repeated on every budget check and stored together with the results.

#### Scenario: Noise floor stored with results
- **WHEN** a frame budget check has been performed
- **THEN** a noise floor measurement from the same session is stored alongside the scenario results

#### Scenario: Noisy floor
- **WHEN** the session's noise floor exceeds the threshold set in the reference environment description
- **THEN** the check is deemed invalid rather than successful

### Requirement: No background stalls
Background work (tokenization, file loading, saving layout and files, cache preparation) SHALL NOT cause dropped frames during interactions.

#### Scenario: Pan during initial load
- **WHEN** the user pans the canvas right after opening a folder, while file highlighting is still in progress
- **THEN** the trace contains no dropped frames

### Requirement: Manual acceptance with real gestures
The repository SHALL contain a manual acceptance procedure: how to perform each interaction from the "Frame budget" requirement in the reference environment using real trackpad and mouse gestures, recording a trace in DevTools Performance. The resulting manual acceptance traces SHALL be stored in the repository. Manual acceptance is the final criterion; automated runs (`performance-harness`) serve to catch regressions during development.

#### Scenario: Reproducing acceptance
- **WHEN** another developer performs the manual acceptance procedure on the reference machine
- **THEN** they obtain traces that can be compared with the traces in the repository, without further explanation from the original author

### Requirement: Interim manual checks
During development, at least once a week, a manual trace with real trackpad gestures (pan, pinch, scroll inside a widget) SHALL be recorded and compared with the result of an automated run of the same interactions. A mismatch between verdicts SHALL be logged as a defect in the automated check.

#### Scenario: Disagreement with automation
- **WHEN** a manual pan trace shows dropped frames but an automated run of the same scenario does not
- **THEN** a defect is filed against the automated check, and its verdict for that scenario is not trusted until fixed

### Requirement: Metrics overlay
The system SHALL have a toggleable (via keyboard shortcut) overlay showing the current FPS, the p99 frame interval over the last few seconds, the number of visible widgets, and the current detail level. A disabled overlay SHALL NOT affect performance.

#### Scenario: Turning the overlay on
- **WHEN** the user presses the overlay keyboard shortcut
- **THEN** metrics appear in a corner of the screen, updated at least once a second
