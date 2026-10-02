## Purpose

Gives developers and AI agents an automatic, reproducible, and trustworthy way to verify the frame budget (`performance-budget`) after every change, ahead of manual acceptance.

## ADDED Requirements

### Requirement: Single-command run
The repository SHALL contain a command that, with no manual steps, builds the application, opens the reference dataset in Chrome in a visible window, plays back the scenarios, collects metrics, and issues a verdict. The command SHALL support a full run of all scenarios, a fast run of a subset, and running selected scenarios by name.

#### Scenario: Full run
- **WHEN** an agent runs the full-run command on the reference machine
- **THEN** all scenarios are played back, a verdict is printed for each, and the command finishes in no more than 10 minutes

#### Scenario: Fast run
- **WHEN** an agent runs the fast run
- **THEN** only the scenarios marked as fast are played back, with the same report format, in no more than 2 minutes

#### Scenario: Scenario selection
- **WHEN** an agent runs the command with the name of a single scenario
- **THEN** only that scenario is played back

### Requirement: Environment preflight
Before the scenarios, the harness SHALL verify that the measurement will be valid, and SHALL abort the run with a non-zero exit code and no metrics output if any of the following conditions is not met:
- the browser is not running in headless mode;
- the browser's idle frame rate is at least 115 Hz;
- none of the browser's launch flags disable vsync or the frame-rate cap;
- the machine is running on AC power;
- the session's noise floor (the "Noise floor" requirement of the `performance-budget` capability) does not exceed the threshold from the reference environment description.
Environment parameters (machine model, Chrome version, display refresh rate, DPR, window size, power source) SHALL be recorded in the report.

#### Scenario: Headless run
- **WHEN** the command is run in headless mode
- **THEN** it exits with a non-zero code and an "invalid measurement" message giving the reason

#### Scenario: 60 Hz display
- **WHEN** the browser window is on a 60 Hz display
- **THEN** the idle frame rate check fails, and the run is aborted with the measured rate reported

#### Scenario: Running on battery
- **WHEN** the machine is running on battery power
- **THEN** the run is aborted with the reason stated

#### Scenario: Noisy floor
- **WHEN** the noise floor measurement taken before the scenarios exceeds the threshold
- **THEN** the run is aborted with an "invalid measurement" code and the floor values

### Requirement: Scenarios as data
Scenarios SHALL be described declaratively (a sequence of gestures with parameters: type, trajectory, speed, duration, initial camera and data state) and stored in the repository. Gestures SHALL be fed through the browser's input pipeline the same way real input arrives: pan and scroll as wheel events, pinch as wheel events with Ctrl, drag and resize as pointer events, typing as keyboard events. Continuous gestures (pan, pinch, scroll, drag, resize) SHALL be fed at no less than the frame rate; typing SHALL be fed at the pace specified in the scenario. The same scenario SHALL produce the same sequence of events on every run. The set of scenarios SHALL cover every scenario of the "Frame budget" requirement and the "No background stalls" requirement of the `performance-budget` capability.

#### Scenario: Budget coverage
- **WHEN** `performance-budget` has a frame budget scenario
- **THEN** the harness has a scenario with the same name, and the harness refuses to run if the correspondence is broken

#### Scenario: Determinism
- **WHEN** the same scenario is played back twice
- **THEN** the sequences of events fed match exactly

### Requirement: Metrics
For each scenario, the harness SHALL collect from the browser trace and from the application:
- the number of frames by status: presented, partially presented, dropped — using the same classification rules as the DevTools Performance panel;
- p50, p95, p99, and the maximum interval between presented frames, and the number of intervals longer than 12.5 ms;
- the longest main-thread task caused by the application code or its libraries, and separately the longest browser task not caused by application code;
- the number and total duration of garbage-collection pauses;
- a breakdown of the application's frame time by stage (input, camera, culling, buffer rebuild, draw) — p50 and p99;
- GPU time per frame, if the browser provides it, with an explicit "unavailable" mark otherwise.

#### Scenario: Per-scenario report
- **WHEN** a scenario has finished
- **THEN** the report contains all of the listed metrics, or an explicit mark that a metric is unavailable

### Requirement: Warm-up and repetitions
Each scenario SHALL be played back a configured number of times after a warm-up. A metric compared against the noise floor (frame counts and long intervals) SHALL fail the scenario only when a majority of the measured runs exceed its allowance (requirement "Budgets and verdict"); absolute budgets, such as the application-task limit and baseline regressions, SHALL be judged on the worst run. The report SHALL show the worst run and the spread across runs.

#### Scenario: One bad run out of five
- **WHEN** one of five runs of a scenario has a dropped frame, the other four have none, and the noise floor is zero
- **THEN** the scenario passes, and the report shows that run's dropped frame

#### Scenario: A drop that repeats
- **WHEN** three of five runs of a scenario each have a dropped frame and the noise floor is zero
- **THEN** the scenario is considered failed

### Requirement: Budgets and verdict
Threshold values SHALL be stored in a version-controlled configuration file, defaulting to the `performance-budget` budget; thresholds for frame counts and long intervals SHALL be compared against the noise floor of the same session, taken as the one-sided 95% Poisson upper bound of the floor's per-minute rate and scaled to the run's duration. The command SHALL exit with a non-zero code if at least one scenario violates a threshold, and SHALL name the scenario, the metric, the threshold, and the actual value.

#### Scenario: Budget violation
- **WHEN** in the pan scenario an application task takes 9.1 ms against a threshold of 8 ms
- **THEN** the command exits with a non-zero code and reports the "pan" scenario, the metric, the threshold of 8, and the actual value of 9.1

### Requirement: Baseline comparison
The harness SHALL store a baseline in the repository — the results of the last accepted run — and show the deviation from it in every report. A metric regression beyond the allowed deviation from the configuration SHALL be flagged as a regression, even if the budget is not violated. Updating the baseline SHALL only be done via an explicit command with interactive human confirmation in the terminal; without confirmation, the command SHALL exit without making changes.

#### Scenario: Regression within budget
- **WHEN** a scenario's p99 rises from 5.0 to 7.5 ms with an allowed deviation of 20%
- **THEN** the report flags a regression, and the command exits with a non-zero code

#### Scenario: Baseline update
- **WHEN** a developer runs the baseline-update command after a successful run and confirms it
- **THEN** the baseline is replaced with the results of that run

#### Scenario: Update without confirmation
- **WHEN** the update command is run non-interactively (for example, by an agent)
- **THEN** the baseline is not changed, and the command exits with a non-zero code

### Requirement: Artifacts
Each run SHALL save: a machine-readable report (JSON), a human-readable table (Markdown), and a trace for each scenario in a format that opens in the DevTools Performance panel.

#### Scenario: Manual trace inspection
- **WHEN** a developer opens a saved scenario trace in DevTools
- **THEN** the number of dropped and partially presented frames in the panel matches the numbers in the harness report

### Requirement: Harness self-test
The application SHALL support a debug mode, enabled only by the harness, that artificially loads the main thread or the GPU for a set duration on every frame. The harness SHALL have a self-test command that, with this load applied, confirms that dropped frames are detected, and without it, confirms that a clean run passes. In a normal run of the application, the debug load SHALL be unavailable.

#### Scenario: Artificial stall detected
- **WHEN** the self-test applies a 12 ms per-frame main-thread load during the pan scenario
- **THEN** the harness records dropped frames and a budget violation

#### Scenario: Artificial GPU load detected
- **WHEN** the self-test applies a GPU load exceeding the frame period, with a light main thread
- **THEN** the harness records dropped or partially presented frames

#### Scenario: Harness produces no false failures
- **WHEN** the self-test runs an empty scene with no load
- **THEN** the harness records no more dropped or partially presented frames than the noise floor measured in preflight allows for the run's duration

### Requirement: Stage-timing mode
The harness SHALL have a mode, available to an agent without a visible browser window and without the reference display, that plays back the same scenarios and compares only the application's frame-stage times and application task durations against the budgets. This mode SHALL NOT issue a verdict on frame rate and SHALL mark the report as "frames not measured"; its exit code SHALL differ from that of the full run.

#### Scenario: Agent iteration
- **WHEN** an agent runs the stage-timing mode in a sandbox with no visible window
- **THEN** it obtains stage and application task times per scenario, marked that frame rate was not verified

### Requirement: Use by agents
The harness command SHALL be part of the development process: a task that touches rendering, input, the frame loop, or background work SHALL be considered complete only after a successful full harness run on the reference machine. A full run SHALL be performed at least twice per working day while work on such tasks is in progress. The harness's output SHALL be concise (a verdict and a table), with details left in the artifacts, so that an agent does not spend context on raw traces.

#### Scenario: Rendering task
- **WHEN** an agent completes a task that changed the frame loop
- **THEN** the task report includes the harness run result and the path to the artifacts
