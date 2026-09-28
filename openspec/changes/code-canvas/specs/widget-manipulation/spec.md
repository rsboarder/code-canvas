## Purpose

Lets the user rearrange widgets and resize them, to organize the files on the canvas as they see fit.

## ADDED Requirements

### Requirement: Dragging a widget
The system SHALL move a widget along with the cursor while it is dragged by its header. While dragging, the widget SHALL be drawn above the others. Widget overlap SHALL be allowed. The new position SHALL be saved (capability `workspace-storage`).

#### Scenario: Dragging by the header
- **WHEN** the user holds the mouse button on a widget's header and moves the cursor
- **THEN** the widget moves along with the cursor with no more than one frame of lag relative to the cursor, other widgets do not move

#### Scenario: Releasing over another widget
- **WHEN** the user releases a widget so that it overlaps another
- **THEN** the widget stays at the release position and is drawn above the overlapped one

#### Scenario: Stack order
- **WHEN** the user clicks any widget
- **THEN** that widget rises above the others and stays on top after a reload

### Requirement: Resizing a widget
The system SHALL resize a widget by dragging its right edge, bottom edge, or bottom-right corner. The size SHALL be no smaller than a minimum (a header and a few lines of code). Resizing SHALL NOT wrap lines of code: long lines are clipped at the right edge. Vertical scroll SHALL be adjusted so it does not extend past the content. The new size SHALL be saved.

#### Scenario: Increasing height
- **WHEN** the user drags a widget's bottom edge downward
- **THEN** the widget grows, shows more lines, the code does not wrap and is not redrawn with a delay

#### Scenario: Minimum size
- **WHEN** the user drags a widget's corner inward past the minimum size
- **THEN** the widget stops at the minimum size

#### Scenario: Resizing while scrolled to the end
- **WHEN** a widget is scrolled to the end of the file and the user increases its height
- **THEN** the scroll decreases so that no more than one widget's worth of empty space appears below the last line

### Requirement: Manipulation at any zoom
Dragging and resizing SHALL work at any detail level, including the minimap, with an edge-grab zone of at least a given number of screen pixels regardless of zoom level.

#### Scenario: Dragging at a far zoom level
- **WHEN** a widget is shown as a minimap and the user drags it by its header
- **THEN** the widget moves the same way as at zoom level 1.0
