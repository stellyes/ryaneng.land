import { brush } from './objects.js';
import { writeLayerCell } from './layers.js';

export function adjustColor(color, { tool, intensity = 50, range = 'midtones', mode = 'saturate' }) {
    if (!['dodge', 'burn', 'sponge'].includes(tool)) throw new Error('Unknown adjustment tool.');
    if (!Number.isInteger(intensity) || intensity < 0 || intensity > 100) throw new Error('Intensity must be a whole number from 0 to 100.');
    if (!['shadows', 'midtones', 'highlights'].includes(range)) throw new Error('Unknown tonal range.');
    if (!['saturate', 'desaturate'].includes(mode)) throw new Error('Unknown sponge mode.');
    if (color === null || intensity === 0) return color;
    const rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16) / 255);
    const amount = intensity / 100;
    let result;
    if (tool === 'sponge') {
        const min = Math.min(...rgb), max = Math.max(...rgb), delta = max - min;
        if (!delta) return color;
        const lightness = (min + max) / 2, limit = 1 - Math.abs(2 * lightness - 1);
        const saturation = delta / limit;
        const adjusted = mode === 'saturate' ? saturation + (1 - saturation) * amount : saturation * (1 - amount);
        result = rgb.map(channel => lightness + (channel - lightness) * adjusted / saturation);
    } else {
        const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        const weight = range === 'shadows' ? (1 - luminance) ** 2 :
            range === 'highlights' ? luminance ** 2 : 4 * luminance * (1 - luminance);
        const strength = amount * weight;
        result = rgb.map(channel => tool === 'dodge' ? channel + (1 - channel) * strength : channel * (1 - strength));
    }
    return '#' + result.map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, '0')).join('');
}

export function adjustBrush(project, layer, x, y, size, options, visited = new Set()) {
    let changed = false, blocked = false;
    brush(x, y, size, (bx, by) => {
        if (bx < 0 || by < 0 || bx >= project.cols || by >= project.rows) return;
        const index = by * project.cols + bx;
        if (visited.has(index)) return;
        visited.add(index);
        const color = layer.cells[index], adjusted = adjustColor(color, options);
        if (color === adjusted) return;
        if (writeLayerCell(layer, index, adjusted)) changed = true;
        else blocked = true;
    });
    return { changed, blocked };
}
