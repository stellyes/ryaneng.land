#!/usr/bin/env python
"""Trace a pixel-grid ornament into a smooth SVG asset for Pattern Studio.

Pipeline (tuned for the pattern-studio ornament library):
  1. Threshold the input image to a 1-bit stitch grid (1 image pixel = 1 cell).
  2. Upscale 16x (nearest) and bridge pure-diagonal links so corner-touching
     chains stay connected.
  3. Gaussian-blur to round the stair-steps, then re-threshold.
  4. Composite crisp pointed shapes for single-pixel features: isolated dots
     become diamonds, 1px line endpoints become tapers whose tip lands exactly
     on the original pixel's outer edge.
  5. Trace with potrace (high alphamax = round corners, sharp tips survive).

The last step renders three smoothing variants side by side in your browser
and asks which one to keep.

Usage:
  python trace-ornament.py grid.png --name "Nouveau Floral Corner" \
      --out ../tools/pattern-studio/assets/ornaments/nouveau-corner.svg

Requires: pillow, numpy, potracer  (python -m pip install pillow numpy potracer)
"""
import argparse
import os
import shutil
import tempfile
import webbrowser

import numpy as np
import potrace
from PIL import Image, ImageDraw, ImageFilter

CELL = 16          # upscale factor per grid cell
GRID_SCALE = 4.0   # viewBox units per grid cell
TURDSIZE = 4       # drop sub-pixel specks introduced by the blur

#            key  label                  blur  alphamax
VARIANTS = [("a", "subtle rounding",     4.5,  1.1),
            ("b", "rounder + tips",      4.5,  1.3),
            ("c", "roundest + tips",     5.0,  1.3)]


def load_grid(path):
    """Threshold the input image to a boolean ink grid (True = ink)."""
    img = Image.open(path).convert("L")
    return np.array(img) < 128


def analyze(G):
    """Find single-pixel features and pure-diagonal links in the grid."""
    h, w = G.shape
    isolated, endpoints, links = [], [], []
    for y in range(h):
        for x in range(w):
            if not G[y, x]:
                continue
            nbs = [(dx, dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                   if (dx or dy) and 0 <= x + dx < w and 0 <= y + dy < h
                   and G[y + dy, x + dx]]
            if len(nbs) == 0:
                isolated.append((x, y))
            elif len(nbs) == 1:
                endpoints.append((x, y, nbs[0]))
            # Corner-touching pixels with both orthogonal cells empty
            for dx, dy in ((1, 1), (1, -1)):
                x2, y2 = x + dx, y + dy
                if (0 <= x2 < w and 0 <= y2 < h and G[y2, x2]
                        and not G[y, x2] and not G[y2, x]):
                    links.append(((x, y), (x2, y2)))
    return isolated, endpoints, links


def build_mask(G, blur, isolated, endpoints, links):
    """Blurred base mask with crisp pointed tips composited on top."""
    h, w = G.shape
    base = G.copy()
    for x, y in isolated:
        base[y, x] = False  # replaced entirely by the diamond
    for x, y, _ in endpoints:
        base[y, x] = False  # replaced by the taper (no blurred nub past the tip)

    base_img = Image.fromarray((base * 255).astype(np.uint8))
    big = base_img.resize((w * CELL, h * CELL), Image.NEAREST)

    # Bridge diagonal links so corner-touching chains stay connected
    db = ImageDraw.Draw(big)
    bw = 0.42 * CELL
    for (x1, y1), (x2, y2) in links:
        c1 = ((x1 + 0.5) * CELL, (y1 + 0.5) * CELL)
        c2 = ((x2 + 0.5) * CELL, (y2 + 0.5) * CELL)
        ux, uy = c2[0] - c1[0], c2[1] - c1[1]
        L = (ux * ux + uy * uy) ** 0.5
        px, py = -uy / L * bw, ux / L * bw
        db.polygon([(c1[0] + px, c1[1] + py), (c1[0] - px, c1[1] - py),
                    (c2[0] - px, c2[1] - py), (c2[0] + px, c2[1] + py)],
                   fill=255)

    big = big.filter(ImageFilter.GaussianBlur(blur))
    mask = np.array(big) > 128

    tips = Image.new("L", (w * CELL, h * CELL), 0)
    d = ImageDraw.Draw(tips)
    for x, y in isolated:
        cx, cy = (x + 0.5) * CELL, (y + 0.5) * CELL
        r = 0.95 * CELL
        d.polygon([(cx + r, cy), (cx, cy + r), (cx - r, cy), (cx, cy - r)],
                  fill=255)
    for x, y, (dx, dy) in endpoints:
        L = (dx * dx + dy * dy) ** 0.5
        ux, uy = -dx / L, -dy / L          # away from the single neighbor
        px, py = -uy, ux
        cx, cy = (x + 0.5) * CELL, (y + 0.5) * CELL
        # Apex sits exactly on the original pixel's outer edge; base reaches
        # well into the neighbor so the taper stays connected.
        apex = (cx + ux * 0.5 * CELL, cy + uy * 0.5 * CELL)
        bx, by = cx - ux * 0.85 * CELL, cy - uy * 0.85 * CELL
        b1 = (bx + px * 0.55 * CELL, by + py * 0.55 * CELL)
        b2 = (bx - px * 0.55 * CELL, by - py * 0.55 * CELL)
        d.polygon([b1, b2, apex], fill=255)

    return np.logical_or(mask, np.array(tips) > 128)


def trace_svg(G, blur, alphamax, title, features, opttolerance=0.3):
    """Trace one variant and return the SVG document string."""
    h, w = G.shape
    arr = build_mask(G, blur, *features)
    scale = GRID_SCALE / CELL

    bmp = potrace.Bitmap(np.logical_not(arr))
    path = bmp.trace(turdsize=TURDSIZE, alphamax=alphamax,
                     opticurve=True, opttolerance=opttolerance)

    def f(v):
        return ("%.2f" % (v * scale)).rstrip("0").rstrip(".")

    parts = []
    for curve in path:
        s = curve.start_point
        parts.append(f"M{f(s.x)} {f(s.y)}")
        for seg in curve:
            e = seg.end_point
            if seg.is_corner:
                c = seg.c
                parts.append(f"L{f(c.x)} {f(c.y)} L{f(e.x)} {f(e.y)}")
            else:
                c1, c2 = seg.c1, seg.c2
                parts.append(f"C{f(c1.x)} {f(c1.y)} {f(c2.x)} {f(c2.y)} "
                             f"{f(e.x)} {f(e.y)}")
        parts.append("Z")

    return (f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {int(w * GRID_SCALE)} {int(h * GRID_SCALE)}" '
            f'fill="currentColor" fill-rule="evenodd">\n'
            f'  <title>{title}</title>\n'
            f'  <path d="{" ".join(parts)}"/>\n</svg>\n')


def choose_variant(src, G, svgs):
    """Render the variants side by side in the browser; ask which to keep."""
    tmp = tempfile.mkdtemp(prefix="trace-ornament-")
    h, w = G.shape
    ref = Image.fromarray(((~G) * 255).astype(np.uint8))
    ref.resize((w * 12, h * 12), Image.NEAREST).save(os.path.join(tmp, "ref.png"))

    cells = ['<div><h4>pixel grid</h4>'
             '<img src="ref.png" width="300" style="image-rendering:pixelated"></div>']
    for (key, label, blur, amax), svg in zip(VARIANTS, svgs):
        name = f"variant-{key}.svg"
        with open(os.path.join(tmp, name), "w", encoding="utf-8") as fh:
            fh.write(svg)
        cells.append(f'<div><h4>{key}: {label} (blur {blur}, alphamax {amax})</h4>'
                     f'<div style="background:#fff;line-height:0;color:#4a1535">'
                     f'<img src="{name}" width="300" height="300"></div></div>')

    html = os.path.join(tmp, "preview.html")
    with open(html, "w", encoding="utf-8") as fh:
        fh.write('<!doctype html><html><body style="background:#eee;padding:12px;'
                 'font-family:sans-serif"><h3>trace-ornament: '
                 f'{os.path.basename(src)}</h3><div style="display:flex;gap:14px;'
                 f'flex-wrap:wrap">{"".join(cells)}</div></body></html>')
    webbrowser.open("file:///" + html.replace(os.sep, "/"))

    keys = [v[0] for v in VARIANTS]
    choice = None
    while choice not in keys:
        choice = input(f"Which variant should I keep? [{'/'.join(keys)}] ").strip().lower()
    shutil.rmtree(tmp, ignore_errors=True)
    return svgs[keys.index(choice)]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("image", help="pixel-grid image (1 image pixel = 1 stitch)")
    ap.add_argument("--name", default=None, help="SVG <title> / ornament name")
    ap.add_argument("--out", default=None, help="output .svg path "
                    "(default: <image name>.svg next to the input)")
    args = ap.parse_args()

    name = args.name or os.path.splitext(os.path.basename(args.image))[0]
    out = args.out or os.path.splitext(args.image)[0] + ".svg"

    G = load_grid(args.image)
    features = analyze(G)
    isolated, endpoints, links = features
    print(f"grid {G.shape[1]}x{G.shape[0]}: {len(isolated)} isolated dots, "
          f"{len(endpoints)} endpoints, {len(links)} diagonal links")

    svgs = [trace_svg(G, blur, amax, name, features)
            for _, _, blur, amax in VARIANTS]
    final = choose_variant(args.image, G, svgs)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(final)
    print(f"wrote {out} ({len(final)} bytes)")
    print('Remember to add it to the ornaments index.json: '
          f'{{"name": "{name}", "file": "{os.path.basename(out)}"}}')


if __name__ == "__main__":
    main()
