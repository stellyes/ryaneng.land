# Pattern Studio (local demo)

[Pattern Studio](index.html) is a dependency-free JavaScript
pixel-art / tapestry crochet editor for tablet and desktop viewports (768px+).
Serve the repository over HTTP (localhost) or HTTPS; no build or backend is needed.
The existing Pages publishing workflow includes the tool automatically.
The editor loads the shared site stylesheet for its Warbler/Sabbath Black fonts,
gold text, forest-green texture, and dark panels. Its compact bottom-right zoom
controls stay on one row.

- Upload PNG, JPEG, WebP or GIF (20 MB maximum; animated images use a still frame),
  or try the built-in sample. The stored reference is resized to a longest edge
  of at most 500 pixels.
- The icon toolbar is divided into Drawing (Paint, Bucket fill, Eraser, Line,
  Shapes), Canvas (Move, Color sampler, Grid size, Crop), Selection/clipboard
  (Select, Copy, Paste, Cut), and History (Undo, Redo) groups.
  Hover or keyboard-focus an icon for its plain-text tooltip; each button also
  has an accessible name. Erase block has been removed.
- Tool settings appear in a fixed right-hand panel inside the canvas frame,
  above Zoom Controls, rather than below the toolbar. Only one settings panel
  is visible at a time: choosing Grid, Crop, or a drawing/selection tool replaces
  the previous panel. The panel scrolls internally when needed and stays put
  while zooming or panning, without resizing the canvas viewport.
- The top-right File dropdown contains Projects, Download project, and Export
  pattern. Selecting an action, clicking/tapping outside, or pressing Escape
  closes the dropdown. Download/export remain unavailable without a project.
- Paint by click, stylus, or drag, use connected four-neighbor bucket fill,
  or erase individual cells. Arrow keys and Space
  provide keyboard painting. Undo/redo includes strokes, fills, and grid resizing.
  Use Ctrl+Z to undo and Ctrl+Shift+Z to redo (Command on Mac), or the toolbar
  buttons. Shortcuts leave text/form editing and open dialogs alone.
- Line draws from the starting cell to the cell where the drag ends. It remains
  a floating preview: drag either endpoint dot to refine it, or drag the line to
  move it. Selecting/adding a palette color recolors the entire preview.
- Shapes offers Rectangle, Circle/Oval, Triangle, and five-point Star, with
  Outline or Filled styles. Drag out a shape, then resize its corner handles or
  enter Width/Height (1-500 cells). The rotation handle or Rotation field
  (0-359 degrees clockwise) rotates around its center. Equal width/height makes
  the oval a circle in grid coordinates. Style, shape, and palette color remain
  editable until placement is finalized.
- Pencil, Line, and outline Shapes each remember their own width (1-20 cells),
  set with the slider or number field in the Tool settings panel (labelled Brush
  size, Line width, or Outline width). The pencil uses a square brush centered on
  the cell (even sizes extend right/down); lines stamp that brush along their
  path; outlines grow inward so the shape keeps its size. Changing Line/Outline
  width updates the floating preview before it is placed. Filled shapes hide the
  control. Widths are kept in this browser's local storage.
- Select highlights an inclusive rectangular section with a dimension label.
  Use Copy then Paste, or Ctrl/Cmd+C and Ctrl/Cmd+V, to create an independent,
  floating duplicate at the visible view center. Pasted sections retain the
  copied colors; empty cells leave existing paint underneath intact. Move,
  resize (nearest-neighbor), or rotate the duplicate like a shape. The clipboard
  is local to this editor tab, supports repeat pastes and different projects,
  and resets on reload; it does not read or write the device's system clipboard.
  Text/form fields retain their native clipboard shortcuts.
- Cut (scissors icon or Ctrl/Cmd+X) copies the selected section and clears the
  original grid cells to transparency, revealing the reference if enabled.
  Paste places the cut section using the same adjustable preview as Copy.
  Cutting is one undo step; Undo restores the removed pixels without clearing
  the clipboard. Cutting an already-empty selection creates no undo step.
- Press Delete with a grid section selected to clear its pixels to transparency
  without changing the clipboard. The removal is one undo step; deleting an
  empty area creates no undo step. Text/form fields keep normal Delete behavior.
- Click away from a floating line/shape/paste inside the pixel-grid viewport
  (on the grid or the empty area around it) to finalize it, or use Apply
  placement. Clicking away on the canvas places it without starting a second
  drawing on the same click. Scrollbars, zoom, the palette, placement settings,
  and controls outside the viewport leave it adjustable, so you can scroll to
  make edits beyond the visible area (choosing another tool still finalizes
  it). Each finalized placement is one undo step. Cancel,
  Escape, or Undo while adjusting discards only the preview. Arrow keys move a
  focused placement or adjust a focused handle (Shift moves farther); Enter
  applies when the canvas or a handle is focused. Space/Enter on a grid cell
  starts a keyboard line, shape, or selection with its end/corner handle focused.
  Pixels outside the grid are clipped, not wrapped. Exports, backups, grid
  resizing, cropping, and project switching finalize pending placements first.
  Autosave stores finalized paint, not editable previews; leaving with a
  preview still open triggers the unsaved-work warning.
- Enlarge the display from 100% (fit) to 800% using the +/- buttons
  overlaid at the bottom-right inside the canvas window, above its scrollbars,
  with Ctrl/Cmd + `+`/`=` and Ctrl/Cmd + `-`, or with Ctrl/Cmd + mouse wheel or a
  trackpad pinch over the canvas (zooms toward the pointer). These replace browser
  page zoom while a project is open.
  Scroll horizontally/vertically to reach enlarged cells; zoom out to the minimum
  to fit the view. Zoom preserves the view center and does not alter the grid, saved
  painting, undo history, or export dimensions. Opening a project resets zoom.
- Select Move to drag the zoomed canvas within its frame using touch, a stylus,
  or a mouse, without painting. Arrow keys pan too (Shift moves farther).
  Move only changes the view, not the pattern or undo history. Choose Paint to
  draw again; touch painting suppresses native scrolling on the canvas.
- New projects start with an empty palette (existing projects keep their colors).
  The collapsible Palette menu overlays the bottom-left inside the canvas window;
  its closed state shows the selected color. Open it to select project colors
  or use Add color. Select a swatch and use the trash button to remove it from
  the palette without changing painted pixels. Another remaining swatch is
  selected automatically; removing the last color leaves the palette empty.
  Palette removals autosave and can be re-added manually or with Color sampler.
  It stays in place while the canvas scrolls; Escape or
  clicking/tapping outside the menu closes it.
  Palette and zoom controls are hidden until a project is loaded.
  Add up to 32 colors manually or choose Color sampler. Sampling temporarily
  hides gridlines and painted cells and shows the full-opacity reference, even
  if Reference is unchecked. An eyedropper cursor and live hex/swatch preview
  follow the pointer; clicking/tapping adds and selects the reference color
  without painting. Repeated colors reuse the existing swatch.
  Transparent reference pixels are sampled over white, as displayed.
  Choose Paint or another tool to restore the normal display; reference/grid
  checkbox preferences are preserved. Arrow keys and Space/Enter also sample
  at the selected cell's center. Painting requires a selected palette color.
- The grid-size toggle exposes a 4-500 cell longest-side slider and a typed
  numeric field. Decimals always round down before range validation; letters
  (including exponent notation), non-numbers, and out-of-range values show an
  inline error. Enter or Apply size commits valid input; invalid input restores
  the previously applied value without changing the pattern.
  Applying it nearest-neighbor resamples existing paint;
  row/column counts round to whole cells while the canvas retains reference proportions.
- Crop overrides the reference proportions with Free form, 1:1, 3:2, 4:3, or
  16:9. A bordered frame and translucent black excluded area preview the crop;
  drag the frame to move it or drag a corner to resize. Free-form Width/Height
  fields work independently, and presets have a Size slider and ratio-locked
  corner handles. Presets snap to whole-pixel multiples for exact proportions;
  references too small for a preset show an error.
  Focus the frame and use arrow keys to move it, or focus a corner and use arrows
  to resize (Shift speeds up). Enter applies; Escape/Cancel leaves the project
  unchanged. Other editing tools are disabled until the crop is applied/cancelled.
  Applying crops the reference and resamples paint at approximately the previous
  cell density; Undo/redo restores both image dimensions and painting. Saved
  projects, sampling, grid resizing, and exports use the cropped dimensions.
- Projects autosave to IndexedDB after edits and can be reopened in Projects.
  Only the resized reference is retained, not the original upload.
  Browser saves are device/origin-specific and can be cleared or evicted;
  use Download project for portable JSON backups, then Import project backup
  to restore an editable copy. Storage failures are shown explicitly, and
  unsaved changes trigger a navigation warning where browsers support it.
- Export PNG/WebP with transparent unpainted cells, or JPG with a chosen
  background. Only painted cells are rendered, without reference or gridlines.
  Scale choices are 1/10/20 pixels per cell on the longest side, capped at 5,000px.
  JPEG is lossy; PNG is recommended for exact pixel colors.

No cloud service, account, tracking, or image upload is used. AWS integration
is deliberately deferred; any future cloud saving must be opt-in with explicit
image-storage and personal-use consent. This is a manual drawing demo, not
automatic image tracing or a written crochet-instruction generator.
Avoid editing the same saved project in multiple tabs simultaneously.

For model/storage tests, serve the repository locally and open
[tests/pattern-studio.html](../../tests/pattern-studio.html). The tests use an isolated,
temporary IndexedDB database and remove it afterwards.

Brush strokes, line/shape/paste previews and the keyboard cursor repaint only
the cells they touch instead of the whole canvas. Cells are drawn from a
one-pixel-per-cell layer in a single scaled draw, and after a zoom only the
tiles near the viewport are painted (the rest fill in as you scroll). While
zooming in, each step only rescales the existing canvas; the sharp
full-resolution redraw runs once zooming pauses for 150 ms (zooming far out
redraws immediately at the smaller size). This keeps
painting, placing, selecting, panning and Ctrl+wheel zoom responsive on large
(e.g. 339 x 500) grids at high zoom. To measure latency, open the editor, load
`tests/pattern-studio-benchmark.js` from the browser console (for example by
appending a `<script>` tag), and run
`await patternStudioBenchmark.run({ painted: true, flush: true, moves: 60 })`
for brush strokes, or
`await patternStudioBenchmark.scenarios({ painted: true, flush: true, moves: 40 })`
for line, shape, select, move and wheel-zoom timings.
`await patternStudioBenchmark.zoomSweep({ direction: 'in' })` reports per-frame
times for a full Ctrl+wheel zoom sweep (keep the tab visible). These import a temporary
benchmark project into this browser's saved projects.
