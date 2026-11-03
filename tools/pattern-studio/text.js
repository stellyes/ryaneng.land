import { transformMatrix, vectorBounds, placementMatrix } from './vector.js';

const MAX_TEXT = 1000;
const MAX_PATH_DATA = 1000000;
const fonts = new Map();
let catalog;

export async function fontCatalog() {
    if (catalog) return catalog;
    const response = await fetch(new URL('./assets/fonts/index.json', import.meta.url));
    if (!response.ok) throw new Error(`Could not load the font catalog (${response.status}).`);
    const entries = await response.json();
    if (!Array.isArray(entries) || !entries.length || entries.some(entry =>
        typeof entry.name !== 'string' || !entry.name.trim() || !/^[\w-]+\.svg$/.test(entry.file)) ||
        new Set(entries.map(entry => entry.file)).size !== entries.length) throw new Error('Invalid font catalog.');
    catalog = entries;
    return catalog;
}

export function parseSvgFont(source) {
    const document = new DOMParser().parseFromString(source, 'image/svg+xml');
    const font = document.querySelector('font'), face = font?.querySelector('font-face');
    if (document.querySelector('parsererror') || !face) throw new Error('Invalid SVG font.');
    const units = Number(face.getAttribute('units-per-em')), ascent = Number(face.getAttribute('ascent'));
    const advance = Number(font.getAttribute('horiz-adv-x'));
    if (!(units > 0) || !Number.isFinite(ascent) || !(advance >= 0)) throw new Error('Invalid SVG font metrics.');
    const glyphs = new Map(), names = new Map(), pairs = new Map();
    const svg = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:1px;height:1px';
    window.document.body.append(svg);
    try {
        const read = node => {
            const d = node.getAttribute('d') || '', value = node.hasAttribute('horiz-adv-x') ? Number(node.getAttribute('horiz-adv-x')) : advance;
            if (!Number.isFinite(value) || value < 0 || d.length > MAX_PATH_DATA) throw new Error('Invalid SVG glyph.');
            const path = window.document.createElementNS(svg.namespaceURI, 'path');
            path.setAttribute('d', d);
            svg.append(path);
            const bounds = path.getBBox();
            path.remove();
            return { d, advance: value, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
        };
        for (const node of font.querySelectorAll('glyph[unicode]')) {
            const unicode = node.getAttribute('unicode').normalize('NFD');
            glyphs.set(unicode, read(node));
            if (node.hasAttribute('glyph-name')) names.set(node.getAttribute('glyph-name'), unicode);
        }
        for (const node of font.querySelectorAll('hkern')) {
            const resolve = side => [
                ...(node.getAttribute(`u${side}`)?.split(',').map(value => value.normalize('NFD')) || []),
                ...(node.getAttribute(`g${side}`)?.split(',').map(name => names.get(name)).filter(Boolean) || []),
            ];
            const value = Number(node.getAttribute('k'));
            if (!Number.isFinite(value)) throw new Error('Invalid SVG kerning.');
            for (const left of resolve(1)) for (const right of resolve(2)) pairs.set(`${left}\0${right}`, value);
        }
        const missing = font.querySelector('missing-glyph');
        const xBounds = glyphs.get('x')?.bounds;
        const xHeight = face.hasAttribute('x-height') ? Number(face.getAttribute('x-height')) :
            xBounds ? xBounds.y + xBounds.height : null;
        if (!Number.isFinite(xHeight) || xHeight <= 0) throw new Error('SVG font needs a positive x-height metric or an x glyph.');
        return { units, ascent, xHeight, glyphs, pairs, missing: missing ? read(missing) : null,
            keys: [...glyphs.keys()].filter(Boolean).sort((a, b) => b.length - a.length) };
    } finally { svg.remove(); }
}

export async function loadSvgFont(file) {
    if (fonts.has(file)) return fonts.get(file);
    if (!(await fontCatalog()).some(entry => entry.file === file)) throw new Error('Choose a font from the catalog.');
    const response = await fetch(new URL(`./assets/fonts/${file}`, import.meta.url));
    if (!response.ok) throw new Error(`Could not load font ${file} (${response.status}).`);
    const font = parseSvgFont(await response.text());
    fonts.set(file, font);
    return font;
}

export function layoutText(font, { content, font: file, size, color, matrix = [1, 0, 0, 1, 0, 0] }) {
    if (typeof content !== 'string' || content.length > MAX_TEXT || !Number.isInteger(size) || size < 1 || size > 500 ||
        !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Text requires up to 1000 characters, a size from 1 to 500 cells, and a valid color.');
    const paths = [], missing = new Set(), scale = size / font.units;
    let x = 0, y = font.ascent, left = 0, top = Infinity, right = 0, bottom = -Infinity, previous = null;
    const normalized = content.replace(/\r\n?/g, '\n').normalize('NFD');
    for (let i = 0; i < normalized.length;) {
        if (normalized[i] === '\n') {
            x = 0; y += font.units * 1.2; previous = null;
            i++; continue;
        }
        const key = font.keys.find(value => normalized.startsWith(value, i)) || String.fromCodePoint(normalized.codePointAt(i));
        const glyph = font.glyphs.get(key) || font.missing;
        if (!font.glyphs.has(key)) missing.add(key);
        if (!glyph) throw new Error(`This font has no glyph for "${key}" and no missing-character fallback.`);
        x -= font.pairs.get(`${previous}\0${key}`) || 0;
        if (glyph.d) {
            paths.push({ d: glyph.d, x, y });
            left = Math.min(left, x + glyph.bounds.x);
            right = Math.max(right, x + glyph.bounds.x + glyph.bounds.width);
            top = Math.min(top, y - glyph.bounds.y - glyph.bounds.height);
            bottom = Math.max(bottom, y - glyph.bounds.y);
        }
        x += glyph.advance;
        right = Math.max(right, x);
        previous = key;
        i += key.length;
    }
    if (!paths.length) { top = 0; bottom = y - font.ascent + font.units * 1.2; }
    for (const path of paths) { path.x -= left; path.y -= top; }
    const text = { content, font: file, size, color: color.toLowerCase(), units: font.units, paths,
        width: Math.max(1, Math.ceil((right - left) * scale)), height: Math.max(1, Math.ceil((bottom - top) * scale)),
        matrix: [...matrix] };
    return { text: updateTextCenter(text, font), missing: [...missing] };
}

function bodyCenter(text) {
    if (!text.paths.length) return text.height / 2;
    const baselines = text.paths.map(path => path.y);
    return (Math.min(...baselines) + Math.max(...baselines) - text.xHeight) / 2 * text.size / text.units;
}

export function updateTextCenter(text, font) {
    const result = { ...text, xHeight: font.xHeight / font.units * text.units };
    result.centerY = bodyCenter(result);
    validateText(result);
    return result;
}

export function fontNamePreview(font, entry) {
    const { text } = layoutText(font, { content: entry.name, font: entry.file, size: 32, color: '#000000' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const scale = text.size / text.units;
    for (const glyph of text.paths) {
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', glyph.d);
        path.setAttribute('transform', `translate(${glyph.x * scale} ${glyph.y * scale}) scale(${scale} ${-scale})`);
        path.setAttribute('fill', 'currentColor');
        svg.append(path);
    }
    svg.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
    document.body.append(svg);
    try {
        const bounds = svg.getBBox();
        const width = Math.max(1, bounds.width), height = Math.max(1, bounds.height);
        svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${width} ${height}`);
        svg.style.cssText = `width:${width / height * 20}px`;
    } finally { svg.remove(); }
    return svg;
}

export function validateText(text) {
    const finite = value => Number.isFinite(value) && Math.abs(value) <= 10000000;
    if (!text || typeof text.content !== 'string' || text.content.length > MAX_TEXT ||
        typeof text.font !== 'string' || !/^[\w-]+\.svg$/.test(text.font) ||
        !Number.isInteger(text.size) || text.size < 1 || text.size > 500 ||
        typeof text.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(text.color) ||
        !finite(text.units) || text.units <= 0 ||
        !Number.isInteger(text.width) || !Number.isInteger(text.height) || text.width < 1 || text.height < 1 ||
        (text.centerY !== undefined && !finite(text.centerY)) ||
        (text.xHeight !== undefined && (!finite(text.xHeight) || text.xHeight <= 0)) ||
        text.width > 8192 || text.height > 8192 || text.width * text.height > 4000000 ||
        !Array.isArray(text.matrix) || text.matrix.length !== 6 || !text.matrix.every(finite) ||
        Math.abs(text.matrix[0] * text.matrix[3] - text.matrix[1] * text.matrix[2]) < 1e-10 ||
        !Array.isArray(text.paths) || text.paths.length > MAX_TEXT ||
        text.paths.some(path => !path || typeof path.d !== 'string' || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]*$/.test(path.d) ||
            !finite(path.x) || !finite(path.y)) ||
        text.paths.reduce((sum, path) => sum + path.d.length, 0) > MAX_PATH_DATA) throw new Error('Invalid or excessively large text layer.');
}

export function transformText(text, matrix) {
    const result = { ...text, matrix: transformMatrix(text.matrix, matrix) };
    validateText(result);
    return result;
}

export function textBounds(text) {
    return vectorBounds(text);
}

export function textCenter(text) {
    const [a, b, c, d, e, f] = text.matrix, x = text.width / 2,
        y = text.xHeight !== undefined ? bodyCenter(text) : text.centerY ?? text.height / 2;
    return { x: a * x + c * y + e, y: b * x + d * y + f };
}

const vectorPaths = new WeakMap();
export function rasterText(text) {
    validateText(text);
    const bounds = textBounds(text);
    if (bounds.width > 8192 || bounds.height > 8192 || bounds.width * bounds.height > 4000000) {
        throw new Error('Text exceeds the 4 million-cell or 8192-cell-side working area. Reduce the size or text length.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = bounds.width; canvas.height = bounds.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const [a, b, c, d, e, f] = text.matrix;
    ctx.setTransform(a, b, c, d, e - bounds.x, f - bounds.y);
    const scale = text.size / text.units;
    let { path, scale: cachedScale } = vectorPaths.get(text.paths) || {};
    if (!path || cachedScale !== scale) {
        path = new Path2D();
        for (const glyph of text.paths) path.addPath(new Path2D(glyph.d), new DOMMatrix([scale, 0, 0, -scale, glyph.x * scale, glyph.y * scale]));
        vectorPaths.set(text.paths, { path, scale });
    }
    ctx.fill(path);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data, entries = [];
    for (let i = 0; i < canvas.width * canvas.height; i++) {
        if (pixels[i * 4 + 3] >= 128) entries.push([bounds.x + i % canvas.width, bounds.y + Math.floor(i / canvas.width), text.color]);
    }
    return entries;
}

export function placedText(text, original, object) {
    return transformText(text, placementMatrix(original, object));
}
