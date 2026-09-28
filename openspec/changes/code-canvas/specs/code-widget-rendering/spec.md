## Purpose

Shows the content of every TypeScript file in a widget with syntax highlighting, and switches the detail level depending on zoom, so code reads well up close while the structure of hundreds of files reads well from afar.

## ADDED Requirements

### Requirement: Code widget
Each widget SHALL show a header with the file's relative path and a body with the file's code in a monospace font, with line numbers, in a dark theme. Token colors SHALL match the colors of the same theme in the active editor (capability `code-editing`), so that colors do not change when entering and exiting editing.

#### Scenario: Displaying a file
- **WHEN** a widget is in the visible area at zoom level 1.0
- **THEN** the file path is visible in the header, along with line numbers and highlighted code, and the text is crisp (not blurred) on a screen with DPR 2

#### Scenario: Same colors as the editor
- **WHEN** the user enters editing of a widget and exits it without edits
- **THEN** the color of each token before entering and after exiting matches that token's color inside the editor

### Requirement: TypeScript syntax highlighting
The system SHALL highlight TypeScript and TSX: keywords, strings and template strings, numbers, comments, types, function identifiers, and JSX tags SHALL have distinguishable theme colors. File highlighting SHALL NOT block display: while tokenization is not yet ready, the code SHALL be shown as single-color monospace text.

#### Scenario: Initial load of 200 files
- **WHEN** a folder with 200 files is opened
- **THEN** widgets appear immediately with unhighlighted text, highlighting appears as it becomes ready, and the frame rate during panning while this happens does not drop below the target (capability `performance-budget`)

#### Scenario: Multi-line constructs
- **WHEN** a file contains a multi-line comment and a multi-line template string
- **THEN** all lines within these constructs are highlighted as a comment and a string, respectively

### Requirement: Detail levels
The system SHALL choose the widget's representation based on the on-screen size of a line of code:
- **Text**: the code line is at least the readability threshold — the actual text is shown with highlighting.
- **Minimap**: the code line is below the threshold — instead of characters, colored bars are shown that mirror each line's length, indentation, and token colors, with the file name overlaid in a large font readable on screen.
Because the on-screen size of a line is the same for every widget, all widgets SHALL show the same detail level at any moment.
Switching SHALL happen within a single frame, with no empty frames and no jump in the widget's geometry. The threshold for switching to "Minimap" when zooming out and the threshold for returning to "Text" when zooming in SHALL differ (hysteresis), so the widget does not flip back and forth when zooming near the threshold.

#### Scenario: Zooming out to the minimap
- **WHEN** the user decreases the zoom level so that a code line drops below the threshold
- **THEN** widgets show the line minimap and a large file name, widget sizes and positions do not change

#### Scenario: All 200 widgets on screen
- **WHEN** "Fit all" is performed for a folder of 200 files
- **THEN** every widget is shown as a minimap with a readable file name

#### Scenario: Transition without flicker
- **WHEN** the user smoothly zooms through the threshold in both directions
- **THEN** in no frame is the widget empty, and in each frame the widget shows exactly one representation

#### Scenario: Oscillation near the threshold
- **WHEN** the user makes small zoom gestures back and forth within the hysteresis band
- **THEN** the widget's representation does not change

### Requirement: Scrolling inside a widget
If a file's content does not fit the widget's height, the system SHALL scroll the widget's content via mouse wheel or two-finger swipe over the widget's body at the "Text" detail level. Once the content edge is reached, the gesture SHALL NOT be passed to canvas pan for the remainder of that gesture, including its momentum phase. At the "Minimap" detail level, the wheel over the widget SHALL pan the canvas. The widget's scroll position SHALL be saved together with the layout, and SHALL stay within the content whenever the file's line count changes.

#### Scenario: Line count shrinks after an edit
- **WHEN** the widget is scrolled near the end of a 2000-line file and an edit shortens the file to 100 lines
- **THEN** the scroll range matches the new length and the widget shows the last lines of the file, with no empty area below them larger than the widget's height

#### Scenario: Scrolling a long file
- **WHEN** the user swipes downward over the body of a widget with a 2000-line file at zoom level 1.0
- **THEN** the code inside the widget scrolls, the canvas stays in place, the widget's header does not scroll

#### Scenario: Content edge
- **WHEN** the widget's content is scrolled to the end and the user continues the same downward swipe
- **THEN** neither the widget nor the canvas moves

#### Scenario: Wheel at a far zoom level
- **WHEN** the widget is shown as a minimap and the user swipes over it
- **THEN** the canvas pans

#### Scenario: Scroll indicator
- **WHEN** the widget's content is longer than its height
- **THEN** a position and visible-fraction indicator is visible at the right edge of the widget's body
