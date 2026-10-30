# Pattern Studio (local demo)

[Pattern Studio](index.html) is a dependency-free JavaScript
pixel-art / tapestry crochet editor for tablet and desktop viewports (768px+).
Serve the repository over HTTP (localhost) or HTTPS; no build or backend is needed.
The existing Pages publishing workflow includes the tool automatically.
The editor loads the shared site stylesheet for its Warbler/Sabbath Black fonts,
gold text, forest-green texture, and dark panels. The right-hand dock contains
tool options, layers, and a magnifier button for zoom controls.

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
  Shapes), Color adjustments (Dodge, Burn, Sponge), Text,
  Canvas (Move, Color sampler, Grid size, Crop), Selection/clipboard
  (Select, Copy, Paste, Cut), and History (Undo, Redo) groups.
  Hover or keyboard-focus an icon for its plain-text tooltip; each button also
  has an accessible name. Erase block has been removed.
- **Text** creates a separate editable text layer, marked **T** in the layer
  list. If the active layer is already text, the tool reopens its options;
  **New text layer** creates another. Tool options contain a multiline text
  field, a font dropdown populated from [the font catalog](assets/fonts/index.json),
  font size in cells (1-500), and text color. Enter inside the text field adds
  a line. Each font name in the picker, including the selected name, previews
  its actual SVG glyphs at a uniform 20px lettering height, without font-metric
  whitespace. Use arrow keys to browse, Enter to select, and Escape
  to close the picker.
  Text is limited to 1000 characters. New layers start with "Text",
  a size suited to the grid, and the selected palette color (or black).
  - The bundled fonts are read directly as SVG fonts, not substituted with
    browser/system fonts. Glyph outlines, advances, multi-character glyphs,
    Unicode normalization, and explicit kerning pairs are used. Missing
    characters display the font's fallback box and an explicit warning.
    Complex script shaping, bidirectional layout, automatic wrapping, and
    additional typographic controls are not included in this iteration.
  - Text is rendered into stitch/pixel cells, with half-covered cells counted
    as painted. Original SVG outlines remain stored separately: changing font
    size, scaling a corner, or rotating regenerates the cells from vector paths
    rather than enlarging an old bitmap. Very small text may lose fine details;
    increase font size or grid resolution to preserve more of the lettering.
    The font-size value is the base em size; corner scaling is an additional
    transform and does not rewrite that value.
  - Select its layer to edit the text again. Drag the box to move, its corners
    to scale, or just outside a corner to rotate; arrow keys and snapping work
    as for painted layers. Moves/scales/rotations are pending placements until
    Enter, click-away, or switching tools commits them; Escape cancels them.
    Text changes update live and are undoable. Canvas resize, extension, mirror,
    rotation, crop, and alignment also preserve/rebase the vector text.
    Text outside the canvas remains editable but is not exported.
  - Text participates in folders, multiselection outlines, duplication,
    visibility, opacity, blending, compositing, previews, yarn suggestions,
    project saving, JSON backups and image exports. Saves include the used SVG
    outlines so saved text renders without re-fetching its font; changing its
    content/font requires the relevant catalog font to remain available.
    These are text-backed raster-stack entries, not a separate flattened image.
  - Paint, erase, adjustment brushes and pixel pastes cannot modify editable
    text. **Rasterize to pixels** explicitly converts it to a normal layer;
    Undo restores text editability. Copy produces a normal pixel clipboard
    image; Cut/Delete do not erase editable text (delete the layer instead).
    Full/color/transparency locks block text edits; position locks block
    geometric transforms and font/size changes. Hidden text cannot be edited.
  - A text working box is limited to four million cells and 8192 cells per
    side, with up to one million characters of glyph-path data per text layer.
    Generated cells also obey the existing aggregate layer-cell budget.
- Tool settings appear in a fixed right-hand panel inside the canvas frame,
  above the layer list, rather than below the toolbar. Only one settings panel
  is visible at a time: choosing Grid, Crop, or a drawing/selection tool replaces
  the previous panel. The panel scrolls internally when needed and stays put
  while zooming or panning, without resizing the canvas viewport.
  Tools without settings show their icon and tool name.
  **Tool options** and **Layers** each start expanded. Click their heading/caret
  (or focus it and press Enter/Space) to collapse to a single line and reopen.
  On short screens the sidebar also scrolls, preserving space for usable layer
  rows and their drag targets rather than shrinking the list out of view.
- With Reference off, empty cells show an 8-screen-pixel gray checkerboard so
  white paint is distinguishable from transparency. It is display-only:
  exports, source pixels, reference sampling, and yarn comparisons are unchanged.
  The checkerboard remains anchored to the board and stays the same screen size
  as you zoom. Reference-on and sampling/cropping retain their white backing.
- Gridlines appear only when each cell is at least 6 CSS pixels wide and tall,
  with sufficient bitmap resolution as well. Below that threshold, only the
  pixel colors are drawn, preventing dense antialiased lines from muting colors.
  Gridlines return automatically when zoomed in; unchecking Gridlines still
  disables them at every zoom. Crossing the threshold invalidates the old
  raster immediately, so stale gridlines are not stretched while zoom settles.
- **Dodge / Burn / Sponge** are square-brush color adjustments on the active
  pixel layer; they do not alter the reference or require a selected palette color.
  Dodge lightens and Burn darkens with **0–100 Intensity** and a
  **Shadows / Midtones / Highlights** tonal range (default Midtones, intensity 50).
  Shadows/highlights use luminance-weighted falloff; midtones peak at middle
  luminance. These are predictable RGB adjustments, not an exact Photoshop
  exposure simulation. Sponge offers **Saturate / Desaturate** plus 0–100
  intensity, adjusting HSL saturation while preserving hue/lightness; neutral
  gray stays neutral when saturating. Each tool has its own brush size (1–20 cells)
  and remembers its settings during the current visit.
  Only existing painted cells inside the canvas are affected. Transparency and
  position locks permit recoloring; painted-color/full locks block it. Hidden
  layers/folders cannot be edited. A pixel is affected once per pointer stroke,
  even where brush stamps overlap; release and brush again to build the effect.
  Keyboard Space/Enter applies one stamp. Each changed stroke is one undo step;
  adjusted colors persist in saves/backups and participate in exports and yarn
  recommendations without automatically expanding the manually managed palette.
- Paint, Eraser, Dodge, Burn and Sponge show a grid-aligned hover outline of
  their exact brush footprint. A size-4 brush previews a 4 x 4 square, with
  even sizes biased right/down exactly as painting is. Eraser also supports
  brush sizes from 1 to 20 cells. The white/dark outline stays readable over different colors,
  follows zoom and scrolling, and clips to the canvas at its edges.
  It hides outside the canvas, during pan/crop/placement, and on touch release.
  This display-only overlay never changes pixels, saves, undo history or exports.
- Press **]** to increase brush size by one cell or **[** to decrease it
  (1–20 cells). This updates the active brush/line/shape outline width and its
  controls immediately, including any hover preview. The shortcuts also work
  with Tool options collapsed or its heading focused; reopening shows the
  updated size. Text inputs, menus,
  dialogs, cropping and modifier-key combinations are left alone.
- Layers are listed top-first, with an isolated thumbnail, inline editable name,
  visibility toggle, and selected-row border. The visibility eye is an unfilled
  outline: beige when visible, light gray when hidden, with no button background.
  The inline name editor fits its text, growing as you type up to the available
  row width; the remaining row space selects the layer rather than editing its name.
  The reference stays underneath the composite and is never listed as a layer.
  Painting, fill, erasing,
  shapes, lines, and clipboard edits affect only the active pixel layer;
  exports, project previews, and yarn recommendations use the visible composite.
  - Select a layer by its thumbnail, row, or name. Its painted bounding box
    becomes a canvas selection; an empty layer selects the entire grid.
    Drag its border to move, its small corner markers to resize, or the area
    just outside any corner to rotate around the center. A curved-arrow cursor
    indicates the invisible rotation zones; the separate rotation knob and
    on-canvas dimension label are omitted. Rotation zones can also be focused
    with Tab and adjusted with arrow keys. Numeric dimensions and rotation
    remain available in Tool options, as with pasted content.
    Enter/Apply commits and Escape cancels. Layer pixels outside the board are
    preserved, but hidden in the editor and omitted from the canvas export.
    Choose a drawing tool to finish this selection and resume painting.
    Move and Space-drag continue to pan the viewport.
  - Hold **Ctrl** (or **Cmd** on Mac) while clicking a row, name, grip, or
    thumbnail to add/remove it from the selection. At least one item remains
    selected. A normal row/thumbnail click selects only that item.
    Each included pixel layer has its own overlapping canvas outline, including
    nested contents of selected folders, even when folders are collapsed.
    Transform handles remain on the active pixel layer only; other outlines
    are display-only and do not intercept pointer input.
    All selected rows are highlighted; the active row has an additional inset
    border. The last added item is active, and painting and canvas transforms
    continue to affect only that active pixel layer.
    Dragging a selected item moves the selected stack items together, preserving
    order and treating a selected folder and its descendants as one group.
    Starting a drag on an unselected item switches to that item.
    Up/Down buttons and grip keyboard arrows move selected stack items.
    Footer copy/folder/trash drops apply to the entire selection; the folder
    button also groups multiple selected items into one folder at the first
    selected position. Copying a selected folder duplicates its full subtree.
    Deleting a selected folder still ungroups its children; explicitly selected
    pixel layers are deleted. Locked members or exceeded limits reject the
    entire operation without partial changes.
    Blend, opacity, and lock controls apply to all selected pixel layers,
    including descendants of selected folders. Mixed locks show a mixed state;
    clicking sets the lock for all. Mixed opacity/blend values show the active
    layer's value (or the first contained pixel layer for an active folder),
    with a mixed-value tooltip. Eye buttons still toggle only their own row.
    Selection is preserved in saves/backups and restored with action undo/redo.
  - Six alignment buttons below the locks align **left / vertical center / right**
    or **top / horizontal center / bottom** to the painted bounds of the
    **bottom-most selected nonempty pixel layer in stack order**, which stays put.
    Selected folders recursively include their pixel layers; duplicates are
    ignored. Empty layers are ignored, including when choosing the anchor.
    Fewer than two participating layers shows a small **Select multiple layers**
    warning that dismisses after 3.5 seconds.
    If exact centering would require half a cell, a confirmation dialog lets the
    user cancel or approve nearest-cell rounding, with ties toward right/bottom.
    Alignment is atomic and undoable. Position/full locks block the operation
    only if a locked layer would actually move; a locked stationary anchor is fine.
  - **Snapping**, checked by default beside Reference and Gridlines, magnetically
    aligns a dragged layer's edges or center axes to the canvas or other visible,
    nonempty pixel layers (including visible folder contents). Red guides show
    the detected metric within 3% of canvas width horizontally or height
    vertically, independent of zoom. Each axis uses its nearest compatible metric.
    Continue dragging beyond this distance to release the snap. Guides disappear
    when the drag ends or is cancelled; they are never painted or exported.
    Snapping only affects pointer moves, not resizing, rotation or arrow-key
    nudges. It preserves whole-cell translations, skipping exact center matches
    that would require half a cell. Turning it off leaves movement unrestricted.
  - Layer moves now retain pixels at negative or beyond-board cell coordinates,
    including fully off-canvas layers. Dragging selection borders or using arrow
    keys can move beyond every canvas edge. Selection outlines/handles extend
    past the grid; layer thumbnails include hidden pixels. Moving the layer
    back reveals its original colors. Layer resize/rotation also retains the
    transformed off-canvas raster. Copy, Cut, Delete, duplication, history,
    IndexedDB saves and JSON backups include these pixels.
    The canvas is the fixed export window: composites, PNG/WebP/JPG, home previews,
    and yarn recommendations include only the board area.
    Off-canvas pixels count toward the existing four-million-layer-cell budget;
    transform/clipboard working bounds are limited to four million cells to
    prevent very large sparse selections from allocating unbounded memory.
    Whole-board extension, mirror, rotation, resize and crop rebase preserved
    outside coordinates with the board. Crop still removes in-board pixels
    outside its chosen area, as before; Undo restores the original board.
  - Checkerboard locks transparency: only existing painted cells can be
    recolored, and they cannot be erased. Brush locks painted colors: only
    transparent cells can be painted. Arrows lock layer transforms, not painting.
    The padlock blocks both pixel editing and transforms; its row badge replaces
    the other lock badges. Selecting both pixel locks blocks all pixel editing.
    Hidden layers/folders must be shown before editing their pixels.
  - The page button creates a blank layer above the selected sibling or inside
    the selected folder. The folder button creates a top-level folder.
    Drag the grip or any unused row space with mouse, pen, or touch to reorder.
    Clicking unused space without dragging selects the layer. The name editor,
    visibility eye, and thumbnail/folder controls retain their normal actions.
    A solid insertion line marks the exact drop position; dropping onto the
    middle of a folder highlights it and inserts the layer as its first child,
    expanding that folder. Dragging a folder moves its entire group.
    Drag a child to a top-level row, the left gutter beside another child, or
    the empty space below the list to ungroup it. The left gutter moves an item
    up one folder level; the empty space moves it to the root.
    Folders can be nested, but cannot contain themselves or their ancestors.
    Nested rows are indented by depth, and hiding/collapsing a folder affects
    all its descendants. Nested folders pass their pixels through in stack order.
    The list auto-scrolls near its upper/lower edges; Escape or releasing outside
    the list and footer targets cancels the drop. Fully locked layers cannot be dragged.
    Keyboard alternative: focus a grip, use Up/Down to reorder siblings,
    Left to ungroup, or Right to enter the nearest preceding folder.
    Click a folder's arrow to expand/collapse it. Up/down footer buttons also
    reorder siblings. Grouping and reordering are saved and undoable.
    The trash button deletes the selected layer, except the last pixel layer or
    a fully locked layer. Deleting a folder promotes its children to that folder's
    parent without deleting their pixels. These edits are undoable.
  - The footer icons also accept dragged layers and highlight before release:
    trash deletes the dragged layer (not a different selected layer); the page
    icon duplicates it immediately above the original in the same folder as
    **[name] copy**, including independent pixels, locks, visibility, opacity,
    and blend mode; the folder icon wraps it in **[name] folder** at the original
    stack position. Wrapping an already-grouped layer creates a nested folder.
    Copy/wrap targets accept layers and folders; dropping a folder onto trash uses
    the non-destructive ungrouping behavior above. Names are shortened only if
    needed to retain the suffix within the 80-character name limit.
    These actions honor layer-count/cell limits and last-layer/full-lock guards,
    are undoable/redoable, and persist in saves and backups.
  - All 27 blend modes are implemented from
    [the supplied mathematical guide](ref/photoshop_blend_modes.md), including
    per-channel modes, whole-pixel Darker/Lighter Color, and W3C-style Hue,
    Saturation, Color, and Luminosity. Computation uses normalized, stored
    (gamma-encoded) RGB, with rounding only for the final 8-bit raster.
    Soft Light and the non-separable modes follow the guide, not a claim of
    bit-for-bit equivalence with Photoshop's proprietary implementation.
  - Opacity is adjustable from 0-100% for each pixel layer and is undoable.
    Alpha is composited correctly even when lower layers are partially
    transparent. Dissolve uses a deterministic hash of the layer ID and cell
    index: the same pattern appears in the editor, saved previews, and exports,
    without flickering during zoom or redraw. At 100%, Dissolve is Normal;
    at 0%, the layer contributes nothing.
    Folders pass their children through; they do not have isolated group modes.
    The reference is never a blend backdrop, and layer thumbnails show the
    unchanged source pixels rather than a baked blend.
  - Native PNG/WebP exports retain composite alpha; JPG composites it onto the
    chosen export background. Yarn recommendations use the composite's
    appearance on white, without the reference. Yarn-color previews/exports
    replace painted cells with opaque yarn colors (a stitch is opaque).
    Source palette colors remain editable and no blend is baked into them.
  - Existing version-1 projects migrate to a single layer when opened. Version-2
    saves/backups preserve layer pixels, names, visibility, locks, folders,
    selection, opacity, and blend choices, plus a flattened compatibility preview
    on white. Actual saved-project thumbnails are rendered from the full layers,
    retaining alpha over the faded reference. Older layer saves with no opacity
    field default to 100%.
    Whole-project resize/crop/add/mirror/rotate edits transform every pixel
    layer (including locked layers) and preserve layer metadata. Per-layer
    transforms leave the reference and other layers unchanged.
  - Projects support up to 64 layer/folder entries and four million total
    raster-layer cells. Larger creations, imports, and grid resizes are rejected
    explicitly rather than discarding layers.
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
- Scale the display from 35% to 800% of fit-to-frame (100%) using the +/- buttons
  overlaid at the bottom-right inside the canvas window, above its scrollbars,
  with Ctrl/Cmd + `+`/`=` and Ctrl/Cmd + `-`, or with Ctrl/Cmd + mouse wheel or a
  trackpad pinch over the canvas (zooms toward the pointer). These replace browser
  page zoom while a project is open.
  Scroll horizontally/vertically with extra space beyond every canvas edge:
  the outermost row or column can reach the center of the viewport, including
  while zoomed in. Zooming out to 35% makes the canvas smaller than its frame.
  Zoom preserves the view center and does not alter the grid, saved
  painting, undo history, or export dimensions. Opening a project resets to
  centered 100% fit. Crop mode temporarily uses a fitted view without extra margins;
  cancelling restores the previous zoom and scroll position.
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
They cover all blend formulas against the supplied guide, alpha/opacity,
deterministic Dissolve, layer migration, locks, transforms, and persistence.
The existing 3EB approximation regression additionally needs its chart fixture
in `feature-reference` (recoverable from Git history if that folder was removed).

[blending.js](blending.js) contains the pure RGB/RGBA formulas;
[layers.js](layers.js) supplies the shared layer compositor used by the canvas,
saved previews, yarn matching, and exports. Bounded per-pass caches reuse repeated
color combinations without retaining unbounded image data.

Brush strokes, line/shape/paste previews and the keyboard cursor repaint only
the cells they touch instead of the whole canvas. Cells are drawn from a
one-pixel-per-cell layer in a single scaled draw, and after a zoom only the
tiles near the viewport are painted (the rest fill in as you scroll). While
zooming in, each step only rescales the existing canvas; the sharp
full-resolution redraw runs once zooming pauses for 150 ms (zooming far out
redraws immediately at the smaller size). This keeps
painting, placing, selecting, panning and Ctrl+wheel zoom responsive on large
(e.g. 339 x 500) grids at high zoom. Layer transforms repaint the composite so
vacated pixels reveal the correct lower layers. To measure latency, open the editor, load
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
