## Purpose

Allows editing code directly on the canvas with a full-featured editor in a single widget at a time, without sacrificing the speed of the other 199 widgets.

## ADDED Requirements

### Requirement: Entering editing
A double click on a widget's body at the "Text" detail level SHALL turn that widget into a full-featured code editor (cursor, selection, copy/paste, undo/redo, in-file search, IME input) with the cursor placed at the click location. At most one editor SHALL be active at a time. Entering editing SHALL preserve the scroll position and SHALL visually match the inactive view (font, size, colors, line positions).

#### Scenario: Double click on a line
- **WHEN** the user double-clicks on line 42 of a widget at zoom level 1.0
- **THEN** the widget becomes an editor, the cursor is placed in line 42 at the click position, the visible lines do not shift

#### Scenario: Double click on another widget
- **WHEN** one widget is in editing mode and the user double-clicks another widget
- **THEN** the first exits editing with its edits saved, the second becomes an editor

#### Scenario: Double click on the minimap
- **WHEN** the user double-clicks a widget shown as a minimap
- **THEN** the view zooms in on that widget to zoom level 1.0, and the widget does not enter editing

### Requirement: Exiting editing
The system SHALL exit editing when the user presses Escape, clicks outside the active widget, starts panning or zooming the canvas by any means, or double-clicks another widget. On exit, edits SHALL be saved (requirement "Saving edits"), and the widget SHALL show the edited code in the same frame, with no intermediate frame showing the old content. If the code has changed, it MAY be shown without highlighting until the new version's highlighting is ready; highlighting SHALL appear no later than 100 ms after for a file of up to 2000 lines.

#### Scenario: Zoom during editing
- **WHEN** the user is typing in the editor and makes a pinch gesture
- **THEN** editing ends, edits are saved, zoom is performed immediately within the same gesture, the widget shows the new code

#### Scenario: Pan during editing
- **WHEN** the user starts panning the canvas (a swipe outside the editor, or dragging empty space) while the editor is open
- **THEN** editing ends with edits saved, pan is performed immediately within the same gesture

#### Scenario: Highlighting after an edit
- **WHEN** the user changed the code and exited editing
- **THEN** the widget shows the new code in the same frame, and highlighting for the new version appears no later than 100 ms after

#### Scenario: Escape
- **WHEN** the user presses Escape in the editor with no open suggestions/search
- **THEN** editing ends, edits are saved

### Requirement: Stationary editor
During editing, the camera and the Widget Frame of the active widget SHALL remain unchanged: dragging and resizing the active widget SHALL be unavailable, and pan and zoom gestures over the canvas outside the editor SHALL end editing (requirement "Exiting editing"). Wheel and swipe over the editor SHALL scroll the editor's content.

#### Scenario: Attempt to drag the active widget
- **WHEN** the user drags the header of a widget that is open in the editor
- **THEN** the widget does not move and editing continues

#### Scenario: Swipe over the editor
- **WHEN** the user swipes over the editor area
- **THEN** the code in the editor scrolls, the canvas stays in place

### Requirement: Saving edits
The system SHALL write edits to the source file on disk when editing ends, and at least every 1 second after the last change while editing. If the write fails, the system SHALL show an error notification and keep the edits in memory until the write succeeds.

#### Scenario: Autosave
- **WHEN** the user typed a character and does nothing for 1 second
- **THEN** the file on disk contains the change

#### Scenario: Write error
- **WHEN** the write to disk fails (for example, permission was revoked)
- **THEN** the user sees a notification, the edits are not lost, and they are written again once access is restored

### Requirement: Typing responsiveness
Each keystroke in the editor SHALL be reflected on screen in the nearest frame, and typing SHALL NOT cause dropped frames either in the editor or on the rest of the canvas (capability `performance-budget`).

#### Scenario: Fast typing
- **WHEN** the user types at a rate of 10 characters per second in a 2000-line file
- **THEN** the trace satisfies the "Frame budget" requirement of capability `performance-budget`
