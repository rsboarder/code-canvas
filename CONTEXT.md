# Code Canvas

An infinite canvas where every TypeScript file in a chosen folder is shown as a separate code widget; the user surveys, arranges, and edits files on the canvas.

## Workspace — files on disk

**Workspace Folder**:
The local folder opened by the user; the source of files and the place edits are written to.
_Avoid_: project, repo, directory

**Source File**:
A TypeScript file (`.ts`/`.tsx`) inside the Workspace Folder that has passed the directory filter.
_Avoid_: document, file (without qualification)

**File Path**:
The Source File's path relative to the root of the Workspace Folder; identifies the file for the user.

**File Revision**:
A snapshot of a Source File's state on disk, used to decide whether an edit can be written without a conflict.
_Avoid_: version

**Content Version**:
The in-app text of a Source File at a given moment; it changes on every edit or re-read, independently of what is on disk.
_Avoid_: revision (that is the on-disk snapshot)

**Save Conflict**:
A situation where a Source File on disk has changed since it was last read, while the user has unsaved edits to the same file.

## Board — the canvas space

**Board**:
The entire spatial layout for a single Workspace Folder: widgets and the camera.
_Avoid_: canvas (that's the name of the product and the drawing surface), scene

**Widget**:
A rectangle on the Board that shows exactly one Source File.
_Avoid_: card, node, tile, window

**Widget Frame**:
The position and size of a Widget in Board coordinates.

**Stack Order**:
The stacking order of widgets: which Widget is drawn on top of which.
_Avoid_: z-index

**Content Scroll**:
Vertical scrolling of the code inside a Widget.

**Camera**:
Which part of the Board is visible on screen: offset and scale.
_Avoid_: viewport (that's the name of the screen area), view

**Zoom**:
The Camera's scale; 1.0 means code at its nominal font size.

**Grid Layout**:
The initial layout rule: widgets arranged in a grid in alphabetical order of File Path.

## Code View — how the code looks

**Tokenized Document**:
The breakdown of a Source File into colored tokens for a specific Content Version.

**Token Run**:
A contiguous span of a line in a single color.

**Theme Palette**:
The set of token colors; shared between widgets and the Editor.

**Detail Level**:
How all Widgets are represented at the current Camera zoom, depending on the on-screen size of a line: Text or Minimap. There is one Detail Level for the whole Board.
_Avoid_: LOD (acceptable only when talking specifically about rendering), zoom level

**Text**:
The Detail Level at which actual code with highlighting is shown.

**Minimap**:
The Detail Level at which colored line stripes and a large File Path are shown instead of characters.
_Avoid_: overview, thumbnail

## Editing — editing code

**Editor**:
The full-featured code editor that one Widget turns into while being edited.

**Editing Session**:
The period during which one Widget is open in the Editor; at most one exists at a time, and during it that widget's Camera and Widget Frame are stationary.
_Avoid_: edit mode, focus

**Draft**:
The text of a Source File in the Editor that has not yet been written to disk.
_Avoid_: buffer, unsaved changes

**Autosave**:
Writing the Draft to disk one second after the last edit, and when the Editing Session ends.

## Performance

**Frame Budget**:
The time budget for a single frame at 120 Hz — 8.33 ms.

**Reference Environment**:
The machine, browser, and dataset against which the Frame Budget is verified.
_Avoid_: test machine

**Reference Dataset**:
A deterministically generated set of 200 Source Files of 2000 lines each — the worst case for measurements.

**Noise Floor**:
The number of dropped and partially presented frames and long intervals on a blank page in the same measurement session; the level below which stalls are not attributed to the application.
_Avoid_: baseline (that's the name for a stored result from a past run)

**Baseline**:
The stored results of the last accepted harness run, against which a new run is compared.
