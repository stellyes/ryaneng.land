export const BLEND_MODES = [
    'Normal', 'Dissolve', 'Darken', 'Multiply', 'Color Burn', 'Linear Burn', 'Darker Color',
    'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge', 'Lighter Color', 'Overlay',
    'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix',
    'Difference', 'Exclusion', 'Subtract', 'Divide', 'Hue', 'Saturation', 'Color', 'Luminosity',
];

const clamp = value => Math.max(0, Math.min(1, value));
const burn = (b, s) => b >= 1 ? 1 : s <= 0 ? 0 : Math.max(0, 1 - (1 - b) / s);
const dodge = (b, s) => b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
const hardLight = (b, s) => s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
const channels = {
    Darken: Math.min,
    Multiply: (b, s) => b * s,
    'Color Burn': burn,
    'Linear Burn': (b, s) => Math.max(0, b + s - 1),
    Lighten: Math.max,
    Screen: (b, s) => 1 - (1 - b) * (1 - s),
    'Color Dodge': dodge,
    'Linear Dodge': (b, s) => Math.min(1, b + s),
    Overlay: (b, s) => hardLight(s, b),
    'Hard Light': hardLight,
    'Soft Light': (b, s) => s <= 0.5
        ? b - (1 - 2 * s) * b * (1 - b)
        : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b),
    'Vivid Light': (b, s) => s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1),
    'Linear Light': (b, s) => clamp(b + 2 * s - 1),
    'Pin Light': (b, s) => s < 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1),
    'Hard Mix': (b, s) => b + s >= 1 ? 1 : 0,
    Difference: (b, s) => Math.abs(b - s),
    Exclusion: (b, s) => b + s - 2 * b * s,
    Subtract: (b, s) => Math.max(0, b - s),
    Divide: (b, s) => s <= 0 ? 1 : Math.min(1, b / s),
};
const lum = c => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const sat = c => Math.max(...c.slice(0, 3)) - Math.min(...c.slice(0, 3));

function setLum(color, value) {
    const difference = value - lum(color);
    let c = color.slice(0, 3).map(channel => channel + difference);
    const l = lum(c), n = Math.min(...c), x = Math.max(...c);
    if (n < 0) c = c.map(channel => l + (channel - l) * l / (l - n));
    if (x > 1) c = c.map(channel => l + (channel - l) * (1 - l) / (x - l));
    return c.map(clamp);
}

function setSat(color, value) {
    const c = color.slice(0, 3), min = Math.min(...c), range = Math.max(...c) - min;
    return range > 0 ? c.map(channel => (channel - min) * value / range) : [0, 0, 0];
}

// Stored (gamma-encoded) RGB, following ref/photoshop_blend_modes.md.
export function blendRgb(base, source, mode) {
    if (mode === 'Normal' || mode === 'Dissolve') return source.slice(0, 3);
    if (mode === 'Darker Color' || mode === 'Lighter Color') {
        const b = base[0] + base[1] + base[2], s = source[0] + source[1] + source[2];
        return (mode === 'Darker Color' ? b <= s : b >= s) ? base.slice(0, 3) : source.slice(0, 3);
    }
    if (mode === 'Hue') return setLum(setSat(source, sat(base)), lum(base));
    if (mode === 'Saturation') return setLum(setSat(base, sat(source)), lum(base));
    if (mode === 'Color') return setLum(source, lum(base));
    if (mode === 'Luminosity') return setLum(base, lum(source));
    const blend = channels[mode];
    if (!blend) throw new Error(`Unknown blend mode: ${mode}`);
    return [0, 1, 2].map(channel => clamp(blend(base[channel], source[channel])));
}

// Unpremultiplied RGBA in [0,1]; retain precision until the final raster.
export function blendPixel(base, source, mode, opacity = 1, noise = 0.5) {
    let a = source[3] * opacity;
    if (mode === 'Dissolve') a = noise < a ? 1 : 0;
    if (a === 0) return base;
    if (a === 1 && (mode === 'Normal' || mode === 'Dissolve')) return source[3] === 1 ? source : [...source.slice(0, 3), 1];
    if (base[3] === 0) return [source[0], source[1], source[2], a];
    const b = base[3], alpha = a + b * (1 - a);
    const mixed = blendRgb(base, source, mode);
    return [
        ...mixed.map((color, i) => ((1 - b) * a * source[i] + b * a * color + (1 - a) * b * base[i]) / alpha),
        alpha,
    ];
}

export function pixelColor(pixel, overWhite = false) {
    if (!pixel || pixel[3] === 0) return null;
    return '#' + pixel.slice(0, 3).map(channel => {
        const value = overWhite ? channel * pixel[3] + 1 - pixel[3] : channel;
        return Math.round(clamp(value) * 255).toString(16).padStart(2, '0');
    }).join('');
}

export function pixelWord(pixel) {
    if (!pixel || pixel[3] === 0) return 0;
    const [r, g, b, a] = pixel.map(channel => Math.round(clamp(channel) * 255));
    return (r | g << 8 | b << 16 | a << 24) >>> 0;
}

export function layerSeed(id) {
    let seed = 2166136261;
    for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
    return seed >>> 0;
}

export function dissolveNoise(seed, index) {
    let hash = (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
    hash = Math.imul(hash ^ hash >>> 16, 0x85ebca6b);
    hash = Math.imul(hash ^ hash >>> 13, 0xc2b2ae35);
    return ((hash ^ hash >>> 16) >>> 0) / 4294967296;
}
