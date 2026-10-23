# Pattern Studio (local demo)

[Pattern Studio](index.html) is a dependency-free JavaScript
pixel-art / tapestry crochet editor for tablet and desktop viewports (768px+).
Serve the repository over HTTP (localhost) or HTTPS; no build or backend is needed.
The existing Pages publishing workflow includes the tool automatically.
The editor loads the shared site stylesheet for its Warbler/Sabbath Black fonts,
gold text, forest-green texture, and dark panels. Its compact bottom-right zoom
controls stay on one row.

- Create new opens a dialog with Blank canvas and Reference image tabs: start
  a blank canvas with 1-500 columns and rows, or upload a reference image.
  Use Left/Right arrows or Home/End to switch focused tabs.
  Blank projects need no image; internally a
  transparent backing keeps them compatible with existing backups and transforms.
- In Reference image, **Estimate a painted grid from this image** is opt-in.
  Leave it unchecked for the original manual-painting flow. Checked uploads
  stay in the dialog until **Create editable pattern** is confirmed; cancelling
  does not change or save the open project.
  - The preview shows the reference and estimated pattern. Width and height
    sliders/numbers preserve the image ratio, up to 500 cells on the longest
    side, and show the total stitch count.
  - Maximum colors is a hard cap of 1-32, not a target: flat images and similar
    shades may need fewer colors. Fine-tuning includes blended-edge reduction, shade merging, minimum
    block size, minimum stitches per color, brightness, contrast, and image
    smoothing. Disable block cleanup to keep single-stitch accents.
  - Estimated image colors, Custom mix, the top five brand lines, and all other
    catalog lines are available as previews. Scores, usage weights, distinct
    yarn assignment, and custom-mix provenance use the editor's existing
    matcher. The color list includes stitch counts, not yardage.
  - Confirmation creates painted, manually editable cells while retaining the
    reference and original estimated colors. A chosen yarn line stays a
    view-only preview, just as in existing projects. It is not baked into the
    source colors. A catalog-load error is shown with a Retry button; estimated
    image colors still work without the catalog.
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
- The start screen lists saved projects in a scrollable menu below the intro,
  with **Create new** (blank canvas or reference image) at the top and projects newest
  first. Each row's background is the project preview (painted cells over a
  faded reference) scaled to the row width without stretching, showing the
  horizontal slice with the most painted cells. Click a row to open it; its ⋮
  menu offers Download and Delete. Try a sample and Import project backup are
  below the list.
- The top-right File dropdown contains Back to projects, Projects, Download project, and Export
  pattern. It is hidden until a project is open. Selecting an action,
  clicking/tapping outside, or pressing Escape closes the dropdown.
  Back to projects finalizes pending placements and saves before returning to
  the start screen. A failed save warns before allowing unsaved work to be discarded.
- The Canvas dropdown beside File edits the whole pattern; each change is one
  undo step:
  - Add column left/right and Add row above/below add one blank line of cells.
    Add multiple columns/rows opens a small dialog for a count and side. Grids
    are limited to 500 cells per side.
  - Mirror horizontal flips left-right across the central vertical axis; Mirror
    vertical flips top-bottom. An odd center column/row stays in place.
  - Rotate right/left turns the pattern 90 degrees.
  - Adding cells never resamples or moves the reference image: new cells sit
    on blank white board space beyond it, so the original work and the
    reference's aspect ratio are preserved. Mirror and rotate flip or turn the
    reference's exact pixels along with the grid. Cropping a padded board
    bakes any blank space inside the crop into the new reference.
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
  drawing on the same click. Scrollbars, Space-drag panning, zoom, the palette, placement settings,
  and controls outside the viewport leave it adjustable, so you can scroll to
  make edits beyond the visible area (choosing another tool still finalizes
  it). Each finalized placement is one undo step. Cancel,
  Escape, Delete/Backspace (for a line, shape, or paste), or Undo while adjusting
  discards only the preview. Arrow keys move a
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
- With any tool, hold Space while the pointer is over the canvas window and drag
  to pan, like Move. It never paints, samples, starts a placement, or counts as a
  click-away, so a floating line/shape/paste stays adjustable. When the keyboard
  cell cursor is active on the canvas, Space keeps painting/sampling that cell.
- Row and column numbers frame the grid in knitting-chart order: columns count
  right to left and rows bottom to top, with odd rows on the right and even rows
  on the left. The bands hug the grid and stay pinned to the edges of the canvas
  window while zoomed in, and the labels grow and shrink with zoom (showing every
  Nth number when cells are too small to label each one). They are hidden while
  cropping.
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

## Product-line color matching

[palette.js](palette.js) exports `findClosestColor(inputColor, palette)` for
future palette-tool integration. Pass a six-digit sRGB hex color and an array
from [yarn-palettes.json](yarn-palettes.json):

```js
import { findClosestColor } from './palette.js';

const closest = findClosestColor('#d1ccc8', palettes["Aunt Lydia's Baby Shower"]);
// '#d0cbc7'
```

The matcher converts sRGB to Oklab and chooses the smallest Euclidean distance
to approximate visual similarity, rather than comparing raw RGB channels.
It returns the original palette entry; ties keep the first entry in list order.
Inputs are case-insensitive `#rrggbb` strings. An empty/missing palette or any
invalid color throws an explicit error, including invalid entries after an
exact match. Neither the palette nor the current painting is modified.
Screen colors are approximations, not a guarantee of a physical yarn match.

## Image approximation

The initial implementation uses [color quantization](https://en.wikipedia.org/wiki/Color_quantization):
deterministic frequency-weighted farthest seeds followed by eight bounded Lloyd/k-means refinement
passes in [Oklab](https://bottosson.github.io/posts/oklab/). Perceptual lightness
and chroma distances distinguish several shades of a hue instead of treating
all reds or blues as one color. Close clusters are merged at the selected
Oklab threshold (slider value divided by 100). A five-bit RGB histogram limits
the work to 32,768 bins, independent of the number of stitches. Palette analysis
uses a separate thumbnail capped at 100px, so raising stitch resolution adds
shape detail rather than extra yarns for image grid lines and blended boundaries.
Disabling blended-edge reduction instead analyzes colors at the selected stitch
resolution, which can retain smaller accents but require more yarn colors.
The seed weighting balances frequency against color diversity so small,
distinct hues such as yellow lettering are not automatically lost to large reds.

With **Reduce blended edge shades** enabled, small clusters (up to 15% of the
largest cluster's usage) close to a color segment between two established shades
are reassigned instead of becoming extra yarns. Rare hue extremes are retained.
This is a conservative heuristic, not semantic understanding: intentional small
intermediate shades can also be removed, so disable it when those are important.
The supplied 3EB chart is regression-tested to produce three reds, yellow,
black, and white at 100, 200, and 500 cells per side, with color caps of 6, 16,
and 32. The actual matched screen shades remain approximations, not canonical
hexes or guarantees about physical yarn.

Rare colors can be reassigned to the nearest retained cluster. A separate
four-connected component pass replaces blocks smaller than the requested
size with their most common bordering color. It deliberately does not dither:
dithering can simulate gradients with alternating pixels, but creates more
isolated yarn changes. This cleanup can also remove small intentional details;
lower it to 0 to preserve those. It is not semantic object/background detection
and does not guarantee every region is at least the chosen size after cleanup.

Sampling uses a reference limited to 500px, with optional browser image smoothing.
Fully transparent sampled cells stay empty; partial transparency is composited
over white before color reduction. A fully transparent image reports an error.
Image color clustering runs in a module Web Worker, with debounced controls;
superseded workers are terminated so a slower result cannot overwrite newer
settings. No image data leaves the browser. Yarn ranking reuses the cached
catalog and the existing matching functions, not a separate scoring formula.

The pure algorithm is in [approximation.js](approximation.js), its worker is in
[approximation-worker.js](approximation-worker.js), and the disposable dialog
state lives in [import-preview.js](import-preview.js). Model tests in
[pattern-studio.html](../../tests/pattern-studio.html) cover color limits,
multi-shade preservation, transparency, block cleanup, rare colors, deterministic
output, settings validation, and aspect-locked sizing.

## Yarn match

The **Yarn** menu beside Palette previews the pattern in one of the 827 yarn
lines from [yarn-palettes.json](yarn-palettes.json) (loaded on first open). It
is view-only: project cells, the palette and saved data keep their original
colors, and Paint still uses the original color you select. Palette swatches
show the original color (upper left) and its yarn (lower right) while
previewing, and a table lists each color's yarn and score. Choose
**Original colors** to return. Opening a project resets the preview.

The menu ranks every line for the current project and shows the top five. A
line's score works like this:

- **Per-color score.** Each color gets `100 * max(0, 1 - d / 0.3)`, where `d`
  is the Oklab distance to its yarn. This replaces a plain RGB percentage,
  which overstates some differences and understates others. Roughly, 0.02 is
  barely noticeable (93), 0.05 a close substitute (83), and 0.1 clearly
  different (67).
- **One yarn per color.** Colors are matched one-to-one to different yarns,
  closest pairs first. Two pattern colors therefore can't both "match" the same
  yarn and become indistinguishable. A line with fewer yarns than your pattern
  has colors leaves the extras without a yarn (score 0). This is what keeps a
  4-color line from being recommended for a 12-color pattern.
- **Near-duplicates share.** Colors closer than 0.04 (nearly identical on
  screen) share one yarn instead of competing for two.
- **Coverage weighting.** The line score is a weighted average: half of each
  color's weight is equal across colors and half follows how many cells use it.
  A poor match for a background color therefore costs more than one for a few
  accent pixels, but rarely used colors still count. Unpainted palette colors
  are included.
- **Usable colors.** A color is usable when its own yarn scores 70 or more.
  Ties are broken by more usable colors, then larger lines.

Above the top matches, a **Custom mix** builds a palette that ignores brand
lines: each color gets the closest yarn from all ~28,000 yarns, with the same
scoring and weighting. Distinct colors still get distinct yarns (each color
considers its 8 nearest yarns, heaviest colors pick first), and identical hexes
sold by different lines count once. Selecting it previews the mix, and the color
table lists each yarn's brand line and hex as a shopping list. Because it can
pick from every line, it normally scores at least as high as the best single
line. The trade-off is buying from several brands, which can mean different
weights and fibers.

Export can optionally render the previewed yarn colors (**Use previewed yarn
colors** in the export dialog); otherwise it uses the original colors. The
scoring functions (`colorUsage`, `prepareYarnLines`, `matchYarnLine`,
`rankYarnLines`, `matchCustomMix`, `closestYarn`) live in [palette.js](palette.js).
Ranking all lines takes about 30 ms for 16 colors and about 125 ms for the
32-color maximum; the custom mix adds about 15 ms.
