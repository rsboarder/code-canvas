## Purpose

Gives the user an infinite canvas that can be freely panned and zoomed, so they can survey hundreds of code widgets at once or read one of them up close.

## ADDED Requirements

### Requirement: Pan
The system SHALL move the canvas view in response to the user's gesture: two-finger trackpad scroll, mouse wheel, dragging empty canvas space with the left mouse button, and dragging with the spacebar held. Content under the cursor SHALL shift by exactly the magnitude of the gesture's events; momentum that the OS generates after the fingers lift SHALL be treated as a continuation of the same gesture, and the application SHALL NOT add momentum of its own.

#### Scenario: Trackpad pan
- **WHEN** the user makes a two-finger swipe on the trackpad over the canvas (with no modifiers held)
- **THEN** the canvas view shifts by the magnitude of the swipe in the same direction, the zoom level does not change

#### Scenario: Pan by dragging empty space
- **WHEN** the user holds the left mouse button on empty canvas space and moves the cursor
- **THEN** the canvas view shifts along with the cursor, the point under the cursor stays under the cursor

#### Scenario: Wheel over a widget with scrolling
- **WHEN** the user scrolls the wheel over a widget whose content does not fit its height
- **THEN** the behavior is governed by the "Scrolling inside a widget" requirement (capability `code-widget-rendering`), not by canvas pan

### Requirement: Zoom
The system SHALL scale the canvas view via a trackpad pinch gesture and via the mouse wheel with Ctrl/Cmd held, keeping the canvas point under the cursor fixed. The zoom level SHALL be limited to the range from 0.05 to 4.0 (1.0 = code at nominal font size). The browser's built-in page zoom SHALL NOT trigger on these gestures.

#### Scenario: Pinch-zoom toward a point
- **WHEN** the user makes a pinch gesture on the trackpad with the cursor over canvas point P
- **THEN** the zoom level changes proportionally to the gesture, and point P stays under the cursor

#### Scenario: Zoom bounds
- **WHEN** the user continues to decrease the zoom level while already at 0.05
- **THEN** the zoom level stays at 0.05, the view does not jitter, and the browser page does not zoom

#### Scenario: Browser zoom does not intercept the gesture
- **WHEN** the user makes a pinch gesture over the canvas
- **THEN** only the canvas scales; the page UI (panels, buttons) keeps its size

### Requirement: Initial grid layout
On first opening a folder, the system SHALL arrange widgets in a simple grid in alphabetical order of the files' relative paths, with equal column widths and a fixed gap between widgets. The default widget height SHALL depend on the file's line count but SHALL NOT exceed a fixed maximum; content that does not fit is available via scrolling inside the widget.

#### Scenario: First opening of a folder
- **WHEN** the user opens a folder that has no saved layout
- **THEN** all widgets are arranged in a grid with no overlaps, in alphabetical order of paths, and the view is fit so the whole grid fits on screen

#### Scenario: Short and long files
- **WHEN** the folder contains a 20-line file and a 2000-line file
- **THEN** the short file's widget is shorter than the long file's widget, and the long file's widget height equals the maximum height

### Requirement: Fit view
The system SHALL provide a "Fit all" action (a button and the Shift+1 shortcut) that fits the view to all widgets, and a "Zoom to 100%" action (Shift+0) that sets the zoom level to 1.0 relative to the screen center.

#### Scenario: Fit all
- **WHEN** the user presses Shift+1
- **THEN** all widgets are fully visible on screen, with a margin at the edges

### Requirement: Camera persistence
The system SHALL save the view's position and zoom level for an open folder and restore them when that same folder is reopened.

#### Scenario: Reopening
- **WHEN** the user closed the tab with the view at position X and zoom level S, and later reopened the same folder
- **THEN** the view is restored at position X and zoom level S
