# Photoshop Layer Blend Modes: The Math Behind the Pixels

A practical reference for how Photoshop combines a **top layer** with the **base layer** beneath it, with formulas, worked examples, and a vectorized Python/NumPy implementation.

---

## 1. Terminology and Conventions

| Symbol | Meaning |
|--------|---------|
| `B` | **Base** (backdrop) value: the composite of everything beneath the layer |
| `S` | **Source/blend** value: the top layer whose blend mode you set |
| `R` | **Result**: the pixel you see after blending |
| `α` | Layer **opacity** (0–1) |

Key points:

- **Values are normalized to 0–1.** For 8-bit images, divide by 255 first, then multiply by 255 and round at the end.
- **Most modes are per-channel.** The formula is applied independently to R, G, and B.
- **A blend mode doesn't change the top layer's data.** It defines how `S` and `B` combine into `R`. "Calculating the top layer's pixel value" in practice means computing the **resulting pixel** (Section 2–5), or, in reverse, solving for the `S` that produces a desired `R` (Section 8).
- Results are **clamped** to 0–1 (0–255 in 8-bit).

---

## 2. The Final Pixel: Blend Mode + Opacity

The blend function `f(B, S)` gives the result at 100% opacity. Opacity then mixes it back with the base:

```
R_final = (1 − α) · B  +  α · f(B, S)
```

If the top layer has its own alpha (transparency) over an opaque base, multiply it into `α`:

```
α_eff   = opacity × layer_alpha
R_final = (1 − α_eff) · B  +  α_eff · f(B, S)
```

For a base that is itself semi-transparent (alpha `αb`), the general compositing form (W3C Compositing spec) is:

```
αo = αs + αb(1 − αs)
Co = [ (1 − αb)·αs·Cs  +  αb·αs·f(Cb, Cs)  +  (1 − αs)·αb·Cb ] / αo
```

---

## 3. Separable Modes (Per-Channel Formulas)

### 3.1 Normal Group

| Mode | Formula | Notes |
|------|---------|-------|
| **Normal** | `R = S` | Top replaces base (before opacity mixing) |
| **Dissolve** | `R = S` with probability `α`, else `R = B` | Random per-pixel dithering; no partial blending. Output differs run to run unless seeded |

### 3.2 Darken Group (result is never lighter than the base)

| Mode | Formula | Intuition |
|------|---------|-----------|
| **Darken** | `R = min(B, S)` | Keeps the darker channel value |
| **Multiply** | `R = B · S` | Like stacking transparencies. White (1) is neutral, black (0) stays black |
| **Color Burn** | `R = 1 − (1 − B) / S` | Darkens and increases contrast. Edge cases: `B = 1 → 1`; `S = 0 → 0` |
| **Linear Burn** | `R = B + S − 1` | Multiply-like but harsher; clamp at 0 |
| **Darker Color** | `R = whichever of B or S has the lower total (R+G+B)` | **Whole-pixel** comparison, not per channel. Never produces new colors |

### 3.3 Lighten Group (result is never darker than the base)

| Mode | Formula | Intuition |
|------|---------|-----------|
| **Lighten** | `R = max(B, S)` | Keeps the lighter channel value |
| **Screen** | `R = 1 − (1 − B)(1 − S)` | Inverse of Multiply. Black (0) is neutral, white stays white |
| **Color Dodge** | `R = B / (1 − S)` | Brightens and increases contrast. Edge cases: `B = 0 → 0`; `S = 1 → 1` |
| **Linear Dodge (Add)** | `R = B + S` | Straight addition; clamp at 1 |
| **Lighter Color** | `R = whichever of B or S has the higher total (R+G+B)` | Whole-pixel comparison |

### 3.4 Contrast Group (50% gray is neutral)

| Mode | Formula |
|------|---------|
| **Overlay** | `B ≤ 0.5 → R = 2·B·S`<br>`B > 0.5 → R = 1 − 2(1 − B)(1 − S)` |
| **Hard Light** | `S ≤ 0.5 → R = 2·B·S`<br>`S > 0.5 → R = 1 − 2(1 − B)(1 − S)` |
| **Soft Light** | `S ≤ 0.5 → R = B − (1 − 2S)·B·(1 − B)`<br>`S > 0.5 → R = B + (2S − 1)·(D(B) − B)`<br>where `D(B) = ((16B − 12)B + 4)B` if `B ≤ 0.25`, else `√B` |
| **Vivid Light** | `S ≤ 0.5 → Color Burn(B, 2S)`<br>`S > 0.5 → Color Dodge(B, 2S − 1)` |
| **Linear Light** | `R = B + 2S − 1` (Linear Burn below 50%, Linear Dodge above) |
| **Pin Light** | `S < 0.5 → R = min(B, 2S)`<br>`S ≥ 0.5 → R = max(B, 2S − 1)` |
| **Hard Mix** | `R = 1 if B + S ≥ 1, else 0` | Posterizes each channel to pure 0 or 1 |

**Relationships worth remembering:**

- **Overlay = Hard Light with the layers swapped.** Overlay's condition tests the *base*, Hard Light's tests the *top*.
- **Soft Light is a gentler Overlay.** The formula above is the W3C/Pegtop-family version; Photoshop's own implementation is proprietary and can differ by a few levels.
- Vivid Light and Linear Light are Burn/Dodge variants applied with doubled contrast.

### 3.5 Inversion Group

| Mode | Formula | Notes |
|------|---------|-------|
| **Difference** | `R = \|B − S\|` | Identical pixels → black |
| **Exclusion** | `R = B + S − 2·B·S` | Lower-contrast Difference |
| **Subtract** | `R = max(B − S, 0)` | Base minus top |
| **Divide** | `R = min(B / S, 1)` | `S = 0 → 1` |

---

## 4. Non-Separable Modes (Hue, Saturation, Color, Luminosity)

These operate on the whole RGB triplet using luminance and saturation helper functions (W3C definitions, which closely match Photoshop):

```
Lum(C)  = 0.30·R + 0.59·G + 0.11·B
Sat(C)  = max(R, G, B) − min(R, G, B)

SetLum(C, l):
    d = l − Lum(C)
    C = C + d                    # add d to every channel
    return ClipColor(C)

ClipColor(C):
    l = Lum(C); n = min(C); x = max(C)
    if n < 0: C = l + (C − l) · l / (l − n)
    if x > 1: C = l + (C − l) · (1 − l) / (x − l)
    return C

SetSat(C, s):
    # scale the spread between min and max channels to equal s,
    # keep the min channel at 0 (all channels 0 if max == min)
```

| Mode | Formula | You get… |
|------|---------|----------|
| **Hue** | `SetLum(SetSat(S, Sat(B)), Lum(B))` | Top's hue; base's saturation and luminosity |
| **Saturation** | `SetLum(SetSat(B, Sat(S)), Lum(B))` | Top's saturation; base's hue and luminosity |
| **Color** | `SetLum(S, Lum(B))` | Top's hue and saturation; base's luminosity |
| **Luminosity** | `SetLum(B, Lum(S))` | Top's luminosity; base's hue and saturation |

> Color and Luminosity are exact opposites: `Color(B, S) = Luminosity(S, B)`.

---

## 5. Worked Example (Single Channel)

Base `B = 0.6` (≈153) and top `S = 0.3` (≈77), 100% opacity.

| Mode | Calculation | R (0–1) | R (0–255) |
|------|-------------|--------:|----------:|
| Normal | `S` | 0.300 | 77 |
| Darken | `min(0.6, 0.3)` | 0.300 | 77 |
| Multiply | `0.6 × 0.3` | 0.180 | 46 |
| Color Burn | `1 − 0.4/0.3 = −0.33` → clamp | 0.000 | 0 |
| Linear Burn | `0.6 + 0.3 − 1 = −0.1` → clamp | 0.000 | 0 |
| Lighten | `max(0.6, 0.3)` | 0.600 | 153 |
| Screen | `1 − 0.4 × 0.7` | 0.720 | 184 |
| Color Dodge | `0.6 / 0.7` | 0.857 | 219 |
| Linear Dodge | `0.6 + 0.3` | 0.900 | 230 |
| Overlay | `B > 0.5`: `1 − 2(0.4)(0.7)` | 0.440 | 112 |
| Hard Light | `S ≤ 0.5`: `2 × 0.6 × 0.3` | 0.360 | 92 |
| Soft Light | `0.6 − 0.4 × 0.6 × 0.4` | 0.504 | 129 |
| Vivid Light | Color Burn(0.6, 0.6): `1 − 0.4/0.6` | 0.333 | 85 |
| Linear Light | `0.6 + 0.6 − 1` | 0.200 | 51 |
| Pin Light | `min(0.6, 0.6)` | 0.600 | 153 |
| Hard Mix | `0.6 + 0.3 = 0.9 < 1` | 0.000 | 0 |
| Difference | `\|0.6 − 0.3\|` | 0.300 | 77 |
| Exclusion | `0.9 − 2 × 0.18` | 0.540 | 138 |
| Subtract | `0.6 − 0.3` | 0.300 | 77 |
| Divide | `0.6 / 0.3 = 2` → clamp | 1.000 | 255 |

*8-bit values are rounded half-up; exact .5 cases (e.g., 76.5) may land ±1 depending on the rounding convention.*

**Adding opacity:** Multiply at 50% → `0.5 × 0.6 + 0.5 × 0.18 = 0.39` → **99**.

### Non-separable example

Base `B = (0.80, 0.40, 0.20)`, top `S = (0.20, 0.50, 0.90)`:

| Mode | Result (R, G, B) |
|------|------------------|
| Hue | (0.280, 0.537, 0.880) |
| Saturation | (0.850, 0.384, 0.150) |
| Color | (0.244, 0.544, 0.944) |
| Luminosity | (0.756, 0.356, 0.156) |

---

## 6. Python Implementation (NumPy, Vectorized)

Operates on whole images at once. Use `float32` to halve memory versus `float64`, and avoid per-pixel Python loops, which are orders of magnitude slower.

```python
import numpy as np

EPS = 1e-6  # guards divisions; inputs are float32 in [0, 1], shape (H, W, 3)

# ---------- separable modes ----------
def normal(b, s):       return s
def darken(b, s):       return np.minimum(b, s)
def multiply(b, s):     return b * s
def color_burn(b, s):
    return np.where(b >= 1, 1.0,
           np.where(s <= 0, 0.0,
                    1 - np.minimum(1.0, (1 - b) / np.maximum(s, EPS))))
def linear_burn(b, s):  return np.clip(b + s - 1, 0, 1)

def lighten(b, s):      return np.maximum(b, s)
def screen(b, s):       return 1 - (1 - b) * (1 - s)
def color_dodge(b, s):
    return np.where(b <= 0, 0.0,
           np.where(s >= 1, 1.0,
                    np.minimum(1.0, b / np.maximum(1 - s, EPS))))
def linear_dodge(b, s): return np.clip(b + s, 0, 1)

def hard_light(b, s):
    return np.where(s <= 0.5, 2 * b * s, 1 - 2 * (1 - b) * (1 - s))
def overlay(b, s):      return hard_light(s, b)   # layers swapped
def soft_light(b, s):
    d = np.where(b <= 0.25, ((16 * b - 12) * b + 4) * b, np.sqrt(b))
    return np.where(s <= 0.5,
                    b - (1 - 2 * s) * b * (1 - b),
                    b + (2 * s - 1) * (d - b))
def vivid_light(b, s):
    return np.where(s <= 0.5, color_burn(b, 2 * s), color_dodge(b, 2 * s - 1))
def linear_light(b, s): return np.clip(b + 2 * s - 1, 0, 1)
def pin_light(b, s):
    return np.where(s < 0.5, np.minimum(b, 2 * s), np.maximum(b, 2 * s - 1))
def hard_mix(b, s):     return np.where(b + s >= 1, 1.0, 0.0)

def difference(b, s):   return np.abs(b - s)
def exclusion(b, s):    return b + s - 2 * b * s
def subtract(b, s):     return np.maximum(b - s, 0)
def divide(b, s):
    return np.where(s <= 0, 1.0, np.minimum(1.0, b / np.maximum(s, EPS)))

# ---------- whole-pixel comparison modes ----------
def darker_color(b, s):
    return np.where((b.sum(-1) <= s.sum(-1))[..., None], b, s)
def lighter_color(b, s):
    return np.where((b.sum(-1) >= s.sum(-1))[..., None], b, s)

# ---------- non-separable modes ----------
def _lum(c):  return 0.3 * c[..., 0] + 0.59 * c[..., 1] + 0.11 * c[..., 2]
def _sat(c):  return c.max(-1) - c.min(-1)

def _clip_color(c):
    l = _lum(c)[..., None]
    n = c.min(-1, keepdims=True)
    x = c.max(-1, keepdims=True)
    c = np.where(n < 0, l + (c - l) * l / np.maximum(l - n, EPS), c)
    c = np.where(x > 1, l + (c - l) * (1 - l) / np.maximum(x - l, EPS), c)
    return c

def _set_lum(c, l):
    return _clip_color(c + (l - _lum(c))[..., None])

def _set_sat(c, s):
    mn = c.min(-1, keepdims=True)
    rng = c.max(-1, keepdims=True) - mn
    return np.where(rng > 0, (c - mn) * s[..., None] / np.maximum(rng, EPS), 0.0)

def hue(b, s):         return _set_lum(_set_sat(s, _sat(b)), _lum(b))
def saturation(b, s):  return _set_lum(_set_sat(b, _sat(s)), _lum(b))
def color(b, s):       return _set_lum(s, _lum(b))
def luminosity(b, s):  return _set_lum(b, _lum(s))

BLEND_MODES = {
    "normal": normal,
    "darken": darken, "multiply": multiply, "color_burn": color_burn,
    "linear_burn": linear_burn, "darker_color": darker_color,
    "lighten": lighten, "screen": screen, "color_dodge": color_dodge,
    "linear_dodge": linear_dodge, "lighter_color": lighter_color,
    "overlay": overlay, "soft_light": soft_light, "hard_light": hard_light,
    "vivid_light": vivid_light, "linear_light": linear_light,
    "pin_light": pin_light, "hard_mix": hard_mix,
    "difference": difference, "exclusion": exclusion,
    "subtract": subtract, "divide": divide,
    "hue": hue, "saturation": saturation, "color": color, "luminosity": luminosity,
}

# ---------- compositing ----------
def blend(base, top, mode="normal", opacity=1.0, top_alpha=None):
    """Composite `top` over an OPAQUE `base`. Returns float32 in [0, 1]."""
    base = base.astype(np.float32, copy=False)
    top = top.astype(np.float32, copy=False)
    result = np.clip(BLEND_MODES[mode](base, top), 0, 1)
    a = np.float32(opacity)
    if top_alpha is not None:                       # (H, W) or (H, W, 1)
        a = a * (top_alpha if top_alpha.ndim == 3 else top_alpha[..., None])
    return (1 - a) * base + a * result

def to_float(img_u8): return img_u8.astype(np.float32) / 255.0
def to_u8(img):       return np.clip(np.rint(img * 255), 0, 255).astype(np.uint8)
```

### Usage

```python
from PIL import Image
import numpy as np

base = to_float(np.array(Image.open("base.png").convert("RGB")))
top  = to_float(np.array(Image.open("top.png").convert("RGB")))   # same size as base

out = blend(base, top, mode="multiply", opacity=0.5)
Image.fromarray(to_u8(out)).save("result.png")
```

### Single-pixel sanity check

```python
b = np.full((1, 1, 3), 0.6, np.float32)
s = np.full((1, 1, 3), 0.3, np.float32)
print(to_u8(blend(b, s, "screen")))   # → [[[184 184 184]]]
```

---

## 7. Opacity vs. Fill

- **Opacity** scales the whole layer, including layer styles (drop shadows, strokes).
- **Fill** scales only the layer's own pixels; effects stay at full strength.
- For most modes, Opacity and Fill give the same pixel result. A handful of modes (notably Hard Mix and the dodge/burn/"light" family) can respond differently to Fill. The formulas above model **Opacity**.

---

## 8. Solving for the Top Layer (Reverse Calculation)

Given a base `B` and a desired result `R`, the top-layer value `S` that produces it (100% opacity):

| Mode | Solve for `S` | Valid when |
|------|---------------|------------|
| Normal | `S = R` | always |
| Multiply | `S = R / B` | `B > 0` |
| Screen | `S = (R − B) / (1 − B)` | `B < 1`, `R ≥ B` |
| Linear Dodge | `S = R − B` | `R ≥ B` |
| Linear Burn | `S = R + 1 − B` | `R ≤ B` |
| Color Dodge | `S = 1 − B / R` | `R > 0`, `R ≥ B` |
| Color Burn | `S = (1 − B) / (1 − R)` | `R < 1`, `R ≤ B` |
| Subtract | `S = B − R` | `R > 0` (clamped values are unrecoverable) |
| Divide | `S = B / R` | `R > 0` |
| Difference | `S = B − R` **or** `S = B + R` | Two solutions |
| Exclusion | `S = (R − B) / (1 − 2B)` | `B ≠ 0.5` |
| Hard Light | `R ≤ B → S = R / (2B)`<br>`R > B → S = 1 − (1 − R) / (2(1 − B))` | — |
| Overlay | Same as Hard Light, but branch on `B ≤ 0.5` instead | — |
| Linear Light | `S = (R − B + 1) / 2` | result not clamped |

**Important limitations:**

- **Clamping destroys information.** If `R` came out as 0 or 255, many `S` values could have produced it, so the inverse is ambiguous.
- **Lossy modes can't be inverted:** Darken, Lighten, Hard Mix, Darker/Lighter Color, Pin Light, Dissolve.
- **Opacity < 100%:** first recover the blended value with `f = B + (R − B) / α`, then invert as above.
- **Non-separable modes** have no clean closed-form inverse; use numerical optimization if you need one.

---

## 9. Caveats When Matching Photoshop Exactly

1. **Gamma.** By default, Photoshop blends the stored (gamma-encoded) values directly. *Color Settings → Advanced Controls → "Blend RGB Colors Using Gamma 1.0"* switches to linear-light blending, which changes results noticeably.
2. **Bit depth.** 8-bit and 16-bit use integer math with rounding; 32-bit float images are not clamped the same way, so out-of-range values can persist through the pipeline.
3. **Approximations.** Photoshop's internals are not published. Expect ±1–2 levels of difference from textbook formulas in some modes, with Soft Light the most likely to differ.
4. **Color space.** Non-separable modes use the luminance weights above (0.30/0.59/0.11) regardless of working color space.
5. **Group blending.** A group set to *Pass Through* blends its children directly with what's below; any other mode first composites the group in isolation, then blends it as one layer. The same layers can produce different results depending on grouping.
6. **Clipping masks and "Blend If".** These modify the effective alpha (`α_eff`) before the blend formula is applied.

---

## 10. Quick Reference by Intent

| I want to… | Use |
|-----------|-----|
| Darken, preserve shadows | Multiply |
| Brighten, preserve highlights | Screen |
| Add contrast with a texture | Overlay, Soft Light, Hard Light |
| Add light-source glow | Linear Dodge (Add), Color Dodge |
| Compare/align two images | Difference |
| Recolor without changing brightness | Color |
| Adjust brightness without changing color | Luminosity |
| Remove a flat background (e.g., white) | Multiply |
| Remove a flat background (e.g., black) | Screen |
| Threshold to pure channels | Hard Mix |
