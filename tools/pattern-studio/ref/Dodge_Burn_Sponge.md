# Photoshop 101 - Burn, Dodge and Sponge Tools

Source: [Shape Shed](https://shapeshed.com/photoshop-101-burn-dodge-and-sponge-tools/)

Published February 5, 2007. Updated September 19, 2024.

> The reference article below is converted from the supplied HTML. The separate
> Pattern Studio implementation description follows it. Photoshop-specific
> behavior described in the article should not be assumed to exist in Pattern
> Studio.

More art-working tools that come straight from the darkroom to Photoshop. You can use these to fine tune your images and correct malformed exposure.

## Straight from the darkroom

These tools come straight from the darkroom floor where the development process
could be tweaked using techniques to change the exposure to the surface of the
photographic paper. Before we look at the tools lets examine the darkroom
techniques to get an idea.

- Dodge - This is where light is blocked out to make portions of the image
  lighter.
- Burn - This is where light is allowed through specific holes to expose the
  paper to more light making it darker.

Understanding that more light means darker and less lighter is just how the
tools work. Let's start with the dodge tool.

The shortcut for all of these tools is O

## Dodge tool - Making selected areas lighter

The Dodge tool is really a post production tool. If you aren't happy with how
the exposure turned out on your photo you can use the Dodge Tool to increase it.
Select your brush and you then have three options: shadows, midtones and
highlights. The tool will target the tone that you choose. Finally set your
exposure. This controls how intense the effect is.

Using the Dodge tool you can easily increase the exposure of photos. In the
following example the left edge of the picture has been lightened using the
Dodge tool. The range was set to midtones and the exposure at 50%. The effect is
slight but compensates for the overexposure of the left hand side.

*Original illustration: Example of using the Dodge Tool.*

## The Burn Tool - the same in reverse

The Burn Tool is really the inverse of the Dodge Tool. Instead of compensating
for overexposure it allows you to darken areas that have been underexposed.

## Sponge Tool - Adjusting Saturation

When you adjust saturation you adjust the strength of a colour. With the sponge
tool you paint with a brush to either increase the saturation of decrease it. In
the following example we have a beautiful photo by
[Barbara Rich](http://www.flickr.com/photos/barbararich/380912249/). Using the
sponge tool we are going to bring out the colours a little more by saturating
them. Specifically the boat and the sky have been "sponged" to saturate the
colours in these areas. Conversely if you wish to tone down colours select
desaturate.

*Original illustration: Example of the Sponge Tool.*

The supplied HTML referenced illustration files that are not present locally.
Their captions are retained above; see the source article for the illustrations.

---

# Pattern Studio implementation

This section describes the implemented editor behavior without code. These tools
follow the reference's general concepts, but do not attempt to reproduce
Photoshop's proprietary exposure processing exactly. The article's O shortcut
has not been implemented.

## Controls and defaults

- **Dodge** lightens existing painted pixels.
- **Burn** darkens existing painted pixels.
- **Sponge** increases or decreases color saturation using **Saturate** or
  **Desaturate** mode.
- Each tool has its own square brush size, from **1 to 20 cells**.
- Each tool offers **Intensity**, from **0 to 100**, through a slider and numeric
  field. Zero leaves colors unchanged; higher values strengthen the effect.
  The default is **50**.
- Dodge and Burn offer **Shadows**, **Midtones**, and **Highlights** targeting,
  defaulting to **Midtones**.
- Sponge defaults to **Saturate** and does not use tonal targeting.
- Each tool retains its intensity and range or mode during the current page
  visit. Brush sizes also use the editor's existing browser-local brush-size
  storage.

## How Dodge and Burn change color

The tool assesses each painted pixel's brightness from its red, green, and blue
components, giving green the strongest influence and blue the weakest.

The selected tonal range changes how strongly the pixel responds:

- **Shadows** favors darker pixels, with strength falling off toward white.
- **Highlights** favors lighter pixels, with strength falling off toward black.
- **Midtones** favors middle brightness and has no effect at pure black or white.

These ranges are smooth falloffs, not hard categories. A pixel outside the
favored range may still change, but less strongly.

Dodge moves each color component toward white; Burn moves it toward black.
The chosen intensity and tonal weighting determine the distance. Final
components are rounded to whole color values and kept within the valid range.
This is a direct adjustment of stored RGB colors, not a photographic exposure
simulation or a layer blending mode.

## How Sponge changes color

Sponge adjusts saturation while retaining the pixel's hue and HSL lightness
before rounding to stored color values.

- **Saturate** moves the pixel toward full saturation by the selected intensity.
- **Desaturate** moves it toward neutral gray by the selected intensity.
- Fully desaturating a pixel produces gray at the same HSL lightness.
- Saturating gray does not invent a hue, and already fully saturated colors
  remain unchanged.

Preserving HSL lightness is not the same as preserving perceived brightness;
rounding can also introduce small differences in the stored result.

## Brush strokes and editing boundaries

- Adjustments affect only the **active pixel layer**, not all selected layers.
- Only painted pixels inside the canvas are eligible. Transparent cells remain
  transparent, and stored off-canvas pixels remain unchanged.
- No palette color is required. The tools adjust existing colors rather than
  painting with the selected swatch.
- A pixel is adjusted **once per pointer stroke**, including when brush stamps
  overlap or the pointer passes over the same pixel again.
- Release the pointer and start another stroke to build up a stronger effect.
- Fast pointer movement fills the path between sampled cells, rather than
  leaving gaps between brush stamps.
- Keyboard **Space** or **Enter** applies one brush stamp at the keyboard cursor.

## Locks and visibility

- **Lock all** and **Lock painted colors** prevent these adjustments.
- **Lock transparency** permits recoloring existing pixels without creating
  new painted cells.
- **Lock position** does not prevent color adjustment.
- Hidden layers, including layers inside hidden folders, cannot be edited.
- Blocked edits use the editor's existing notification system.

## Undo, saving, and output

Each pointer stroke that actually changes pixels creates one undo step.
Unchanged strokes, including zero-intensity strokes, do not add history.
Keyboard stamps that change pixels are separate undo steps.

Adjusted colors are stored as ordinary layer pixels, so they participate in
undo/redo, browser saves, project backups, layer blending, exports, and yarn
recommendations. The tools do not alter the reference image or automatically
add generated shades to the manually managed palette.
