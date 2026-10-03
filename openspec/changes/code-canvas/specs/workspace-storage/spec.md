## Purpose

Connects the canvas to a real folder on the user's disk: files are read from there, edits are written back there, and the canvas layout survives a reload.

## ADDED Requirements

### Requirement: Opening a folder
The system SHALL let the user pick a local folder via the system dialog and recursively load files with the `.ts` and `.tsx` extensions from it, skipping the `node_modules`, `.git`, `dist`, `build` directories and hidden directories. Each file found SHALL become one widget.

#### Scenario: Project folder
- **WHEN** the user selects a folder with 200 TS files and a node_modules directory
- **THEN** the canvas has exactly 200 widgets, with no files from node_modules

### Requirement: Large and atypical files
The system SHALL load files of any size, but the target performance figures are guaranteed for files up to 2000 lines and folders up to 200 files. Files that do not decode as UTF-8 SHALL be shown as a widget with an error message instead of code.

#### Scenario: File larger than 2000 lines
- **WHEN** the folder contains a 5000-line file
- **THEN** it opens as an ordinary widget with scrolling

#### Scenario: Folder larger than 200 files
- **WHEN** the folder has 350 TS files
- **THEN** all 350 files are loaded

### Requirement: Reopening the last folder
The system SHALL remember the last opened folder and, on the next launch, offer to reopen it in one action (requesting browser permission if required).

#### Scenario: Restart
- **WHEN** the user reloads the page
- **THEN** the system offers to open the last folder, and after confirmation the canvas is restored with its previous layout

### Requirement: Layout persistence
The system SHALL save, for each folder, the widgets' positions, sizes, stack order, and scroll positions, as well as the camera, and restore them when the folder is reopened. The layout SHALL be saved no later than 1 second after a change. Widgets for new files that were not in the saved layout SHALL be added in free space to the right of the existing grid; entries for missing files SHALL be discarded.

#### Scenario: Reload after rearranging
- **WHEN** the user moved and resized a widget, waited 1 second, and reloaded the page
- **THEN** the widget is at the new position with the new size

#### Scenario: New file in the folder
- **WHEN** a new TS file appeared in the folder between sessions
- **THEN** it appears as a new widget on opening, without overlapping existing ones

### Requirement: External file changes
The system SHALL reread the file from disk when entering editing of it. If the file on disk has changed since it was last read, and the product has unsaved edits to that file, the system SHALL NOT silently overwrite the file, but SHALL show a choice: keep the version from disk or overwrite it with its own.

#### Scenario: Conflict with an external change
- **WHEN** a file is changed in an external editor while the product has unsaved edits to that same file
- **THEN** on attempting to write, the system shows a choice between the version from disk and its own version
