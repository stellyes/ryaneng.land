import { transformMatrix, vectorBounds, placementMatrix } from './vector.js';

const identity = [1, 0, 0, 1, 0, 0];
const loaded = new Map();
let catalog;
const safeFile = value => typeof value === 'string' && /^[\w-]+\.svg$/.test(value);
const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const finite = value => Number.isFinite(value) && Math.abs(value) <= 10000000;
const matrixValid = matrix => Array.isArray(matrix) && matrix.length === 6 && matrix.every(finite) &&
    Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) >= 1e-10;

export function validateAssetCatalog(entries) {
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.name !== 'string' ||
        !entry.name.trim() || entry.name.length > 80 || !safeFile(entry.file) ||
        !['ornament', 'border'].includes(entry.type) ||
        !(entry.collection === null || typeof entry.collection === 'string' && entry.collection.trim()) ||
        !Array.isArray(entry.tags) || !entry.tags.every(tag => typeof tag === 'string') ||
        ![entry.preview_width, entry.preview_height].every(value => Number.isInteger(value) && value >= 1 && value <= 500)) ||
        new Set(entries.map(entry => entry.file)).size !== entries.length) throw new Error('Invalid asset library catalog.');
    return entries;
}

export async function assetCatalog() {
    if (catalog) return catalog;
    const response = await fetch(new URL('./assets/ornaments/index.json', import.meta.url));
    if (!response.ok) throw new Error(`Could not load the asset library (${response.status}).`);
    catalog = validateAssetCatalog(await response.json());
    return catalog;
}

export function assetList(entries, type, query = '', collection = null) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matching = entries.filter(entry => entry.type === type && terms.every(term =>
        `${entry.name} ${entry.tags.join(' ')}`.toLowerCase().includes(term)));
    if (terms.length) return matching.map(asset => ({ asset }));
    if (collection !== null) return matching.filter(entry => entry.collection === collection).map(asset => ({ asset }));
    const groups = new Set();
    return matching.flatMap(asset => {
        if (asset.collection === null) return [{ asset }];
        if (groups.has(asset.collection)) return [];
        groups.add(asset.collection);
        return [{ collection: asset.collection }];
    });
}

export function parseAssetSvg(source) {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml'), root = doc.documentElement;
    if (doc.querySelector('parsererror') || root.localName !== 'svg') throw new Error('Invalid asset SVG.');
    const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (viewBox.length !== 4 || !viewBox.every(finite) || viewBox[2] <= 0 || viewBox[3] <= 0) throw new Error('Asset SVG needs a valid viewBox.');
    const paths = [];
    const transformNode = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    function visit(node, matrix, rule, fill) {
        // Only geometry is reconstructed; scripts (including dev-server reload scripts) never enter the live DOM.
        if (node.localName === 'script') return;
        if (!['svg', 'g', 'path', 'title', 'desc', 'metadata'].includes(node.localName)) throw new Error(`Unsupported asset SVG element: ${node.localName}. Use filled paths and groups.`);
        if (['title', 'desc', 'metadata'].includes(node.localName)) return;
        for (const attr of node.attributes) {
            if (/^on/i.test(attr.name) || /href|style/i.test(attr.name) || /url\s*\(/i.test(attr.value)) throw new Error('Asset SVG contains unsupported active or external content.');
            if (!['viewBox', 'xmlns', 'width', 'height', 'version', 'id', 'd', 'fill', 'fill-rule', 'transform', 'stroke'].includes(attr.name)) throw new Error(`Unsupported asset SVG attribute: ${attr.name}.`);
        }
        if (node.hasAttribute('stroke') && node.getAttribute('stroke') !== 'none') throw new Error('Asset strokes must be converted to filled paths.');
        if (node.hasAttribute('transform')) {
            transformNode.setAttribute('transform', node.getAttribute('transform'));
            const value = transformNode.transform.baseVal.consolidate()?.matrix;
            if (!value) throw new Error('Invalid asset SVG transform.');
            matrix = transformMatrix([value.a, value.b, value.c, value.d, value.e, value.f], matrix);
        }
        rule = node.getAttribute('fill-rule') || rule;
        fill = node.getAttribute('fill') || fill;
        if (!['evenodd', 'nonzero'].includes(rule) || !(fill === 'none' || fill === 'currentColor' || hex(fill))) throw new Error('Unsupported asset fill.');
        if (node.localName === 'path' && fill !== 'none') paths.push({ d: node.getAttribute('d') || '', matrix: [...matrix], fillRule: rule });
        for (const child of node.children) visit(child, matrix, rule, fill);
    }
    visit(root, identity, 'nonzero', 'currentColor');
    if (!paths.length) throw new Error('Asset SVG has no filled paths.');
    const data = { name: 'Asset', file: 'asset.svg', kind: 'ornament', viewBox, paths,
        width: 34, height: 34, color: '#000000', matrix: [...identity] };
    validateAsset(data);
    return { viewBox, paths };
}

export async function loadAsset(file) {
    if (loaded.has(file)) return loaded.get(file);
    if (!(await assetCatalog()).some(entry => entry.file === file)) throw new Error('Choose an asset from the library.');
    const response = await fetch(new URL(`./assets/ornaments/${file}`, import.meta.url));
    if (!response.ok) throw new Error(`Could not load asset ${file} (${response.status}).`);
    const data = parseAssetSvg(await response.text());
    loaded.set(file, data);
    return data;
}

export function validateAsset(asset) {
    if (!asset || !safeFile(asset.file) || typeof asset.name !== 'string' || !asset.name.trim() || asset.name.length > 80 ||
        !['ornament', 'border'].includes(asset.kind) || !hex(asset.color) || !matrixValid(asset.matrix) ||
        !Array.isArray(asset.viewBox) || asset.viewBox.length !== 4 || !asset.viewBox.every(finite) ||
        asset.viewBox[2] <= 0 || asset.viewBox[3] <= 0 ||
        ![asset.width, asset.height].every(v => Number.isInteger(v) && v >= 1 && v <= 8192) ||
        asset.width * asset.height > 4000000 || !Array.isArray(asset.paths) || !asset.paths.length || asset.paths.length > 1000 ||
        asset.paths.some(path => !path || typeof path.d !== 'string' || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(path.d) ||
            !matrixValid(path.matrix) || !['nonzero', 'evenodd'].includes(path.fillRule)) ||
        asset.paths.reduce((sum, path) => sum + path.d.length, 0) > 1000000) throw new Error('Invalid or excessively large asset layer.');
}

export function createAsset(entry, source, size, color, matrix = identity) {
    if (!Number.isInteger(size) || size < 15 || size > 250) throw new Error('Asset size must be from 15 to 250 cells.');
    const [, , w, h] = source.viewBox, scale = size / Math.max(w, h);
    const asset = { ...source, name: entry.name, file: entry.file, kind: entry.type,
        width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), color, matrix: [...matrix] };
    validateAsset(asset);
    return asset;
}

export function transformAsset(asset, matrix) {
    const result = { ...asset, matrix: transformMatrix(asset.matrix, matrix) };
    validateAsset(result);
    return result;
}

export function placedAsset(asset, original, object) {
    return transformAsset(asset, placementMatrix(original, object));
}

const pathsCache = new WeakMap();
export function rasterAsset(asset) {
    validateAsset(asset);
    const bounds = vectorBounds(asset);
    if (bounds.width > 8192 || bounds.height > 8192 || bounds.width * bounds.height > 4000000) throw new Error('Asset exceeds the 4 million-cell working area. Reduce its size.');
    const canvas = document.createElement('canvas');
    canvas.width = bounds.width; canvas.height = bounds.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const [a, b, c, d, e, f] = asset.matrix, [x, y, w, h] = asset.viewBox;
    ctx.setTransform(a, b, c, d, e - bounds.x, f - bounds.y);
    ctx.scale(asset.width / w, asset.height / h);
    ctx.translate(-x, -y);
    let paths = pathsCache.get(asset.paths);
    if (!paths) { paths = asset.paths.map(path => new Path2D(path.d)); pathsCache.set(asset.paths, paths); }
    asset.paths.forEach((path, i) => {
        ctx.save(); ctx.transform(...path.matrix); ctx.fill(paths[i], path.fillRule); ctx.restore();
    });
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data, entries = [];
    for (let i = 0; i < canvas.width * canvas.height; i++) {
        if (pixels[i * 4 + 3] >= 128) entries.push([bounds.x + i % canvas.width, bounds.y + Math.floor(i / canvas.width), asset.color]);
    }
    return entries;
}

export function assetThumbnail(source) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', source.viewBox.join(' '));
    svg.setAttribute('aria-hidden', 'true');
    for (const item of source.paths) {
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', item.d);
        path.setAttribute('transform', `matrix(${item.matrix.join(' ')})`);
        path.setAttribute('fill-rule', item.fillRule);
        path.setAttribute('fill', 'currentColor');
        svg.append(path);
    }
    return svg;
}
