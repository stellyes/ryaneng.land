import { transformMatrix, vectorBounds, placementMatrix } from './vector.js';
import { validateRepeatLayout, repeatingBorderPlan } from './border-layout.js';

const identity = [1, 0, 0, 1, 0, 0];
const loaded = new Map();
let catalog;
const safeFile = value => typeof value === 'string' && /^[\w-]+\.(svg|png)$/.test(value);
const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const finite = value => Number.isFinite(value) && Math.abs(value) <= 10000000;
const matrixValid = matrix => Array.isArray(matrix) && matrix.length === 6 && matrix.every(finite) &&
    Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) >= 1e-10;

function breakpointsValid(points) {
    return Array.isArray(points) && points.length <= 8 && points.every(point => point &&
        ['x', 'y'].includes(point.axis) && Number.isFinite(point.position) &&
        point.position > 0 && point.position < 1) &&
        new Set(points.map(point => `${point.axis}:${point.position}`)).size === points.length;
}

export function validateAssetCatalog(entries) {
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.name !== 'string' ||
        !entry.name.trim() || entry.name.length > 80 || !safeFile(entry.file) ||
        !['ornament', 'border'].includes(entry.type) ||
        (entry.repeating !== undefined && typeof entry.repeating !== 'boolean') ||
        (entry.breakpoints !== undefined && !breakpointsValid(entry.breakpoints)) ||
        (entry.repeating === true && entry.breakpoints?.length > 0) ||
        !(entry.collection === null || typeof entry.collection === 'string' && entry.collection.trim()) ||
        !Array.isArray(entry.tags) || !entry.tags.every(tag => typeof tag === 'string') ||
        ![entry.preview_width, entry.preview_height].every(value => Number.isInteger(value) && value >= 1 && value <= 500)) ||
        new Set(entries.map(entry => entry.file)).size !== entries.length) throw new Error('Invalid asset library catalog.');
    for (const entry of entries) {
        if (entry.file.endsWith('.png') && !entry.repeat_layout) throw new Error('Pixel-grid assets require a repeating border recipe.');
        if (entry.repeat_layout !== undefined) {
            if (entry.type !== 'border' || entry.repeating !== true) throw new Error('Repeat recipes require a repeating border.');
            validateRepeatLayout(entry.repeat_layout);
        }
    }
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
    const entry = (await assetCatalog()).find(entry => entry.file === file);
    if (!entry) throw new Error('Choose an asset from the library.');
    const response = await fetch(new URL(`./assets/ornaments/${file}`, import.meta.url));
    if (!response.ok) throw new Error(`Could not load asset ${file} (${response.status}).`);
    let data;
    if (file.endsWith('.png')) {
        const bitmap = await createImageBitmap(await response.blob());
        try {
            if (bitmap.width > 1000 || bitmap.height > 1000) throw new Error('Asset pixel grids cannot exceed 1000 cells per side.');
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0);
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            const pixelGrid = Array.from({ length: canvas.height }, (_, y) =>
                Array.from({ length: canvas.width }, (_, x) => {
                    const i = (y * canvas.width + x) * 4;
                    return pixels[i + 3] >= 128 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 128 ? '1' : '0';
                }).join(''));
            data = { viewBox: [0, 0, canvas.width, canvas.height], paths: [], pixelGrid };
        } finally { bitmap.close(); }
    } else data = parseAssetSvg(await response.text());
    if (entry.repeat_layout) {
        validateRepeatLayout(entry.repeat_layout, data.viewBox);
        data.repeatLayout = structuredClone(entry.repeat_layout);
    }
    loaded.set(file, data);
    return data;
}

export function validateAsset(asset) {
    if (!asset || !safeFile(asset.file) || typeof asset.name !== 'string' || !asset.name.trim() || asset.name.length > 80 ||
        !['ornament', 'border'].includes(asset.kind) || !hex(asset.color) || !matrixValid(asset.matrix) ||
        !Array.isArray(asset.viewBox) || asset.viewBox.length !== 4 || !asset.viewBox.every(finite) ||
        asset.viewBox[2] <= 0 || asset.viewBox[3] <= 0 ||
        ![asset.width, asset.height].every(v => Number.isInteger(v) && v >= 1 && v <= 8192) ||
        asset.width * asset.height > 4000000 || !Array.isArray(asset.paths) ||
        (!asset.paths.length && !asset.pixelGrid) || asset.paths.length > 1000 ||
        asset.paths.some(path => !path || typeof path.d !== 'string' || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(path.d) ||
            !matrixValid(path.matrix) || !['nonzero', 'evenodd'].includes(path.fillRule)) ||
        asset.paths.reduce((sum, path) => sum + path.d.length, 0) > 1000000) throw new Error('Invalid or excessively large asset layer.');
    if (asset.pixelGrid !== undefined && (!Array.isArray(asset.pixelGrid) || !asset.pixelGrid.length ||
        asset.pixelGrid.length > 1000 || typeof asset.pixelGrid[0] !== 'string' ||
        !asset.pixelGrid[0].length || asset.pixelGrid[0].length > 1000 ||
        asset.pixelGrid.some(row => typeof row !== 'string' || row.length !== asset.pixelGrid[0].length || !/^[01]+$/.test(row)) ||
        asset.viewBox.join() !== [0, 0, asset.pixelGrid[0].length, asset.pixelGrid.length].join() ||
        !asset.repeatLayout || asset.paths.length)) {
        throw new Error('Invalid saved border pixel grid.');
    }
    if ((asset.repeating !== undefined && typeof asset.repeating !== 'boolean') ||
        (asset.breakpoints !== undefined && !breakpointsValid(asset.breakpoints)) ||
        (asset.repeating === true && asset.breakpoints?.length > 0) ||
        (asset.borderBase !== undefined && (asset.kind !== 'border' || asset.repeating !== false ||
            !asset.breakpoints?.length || !Array.isArray(asset.borderBase) || asset.borderBase.length !== 2 ||
            !asset.borderBase.every(value => Number.isInteger(value) && value >= 1 && value <= 250)))) {
        throw new Error('Invalid border extension metadata.');
    }
    if (asset.repeatLayout !== undefined) {
        if (asset.kind !== 'border' || asset.repeating !== true || asset.borderBase ||
            !finite(asset.borderThickness) || asset.borderThickness <= 0) {
            throw new Error('Invalid repeating border thickness or type.');
        }
        validateRepeatLayout(asset.repeatLayout, asset.viewBox);
        const maximum = asset.repeatLayout.maxThickness;
        if (maximum && asset.borderThickness * Math.max(Math.hypot(...asset.matrix.slice(0, 2)),
            Math.hypot(...asset.matrix.slice(2, 4))) > maximum + 1e-8) {
            throw new Error(`This pixel border cannot exceed ${maximum} cells thick.`);
        }
        repeatingBorderPlan(asset.repeatLayout, asset.width, asset.height, asset.borderThickness);
    }
}

export function createAsset(entry, source, size, color, matrix = identity) {
    if (!Number.isInteger(size) || size < (entry.repeat_layout ? 1 : 15) || size > (entry.repeat_layout ? 1000 : 250)) {
        throw new Error(entry.repeat_layout ? 'Border thickness must be from 1 to 1000 cells.' : 'Asset size must be from 15 to 250 cells.');
    }
    const [, , w, h] = source.viewBox, scale = size / Math.max(w, h);
    const asset = { ...source, name: entry.name, file: entry.file, kind: entry.type,
        width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), color, matrix: [...matrix] };
    if (entry.type === 'border') {
        asset.repeating = entry.repeating ?? false;
        asset.breakpoints = (entry.breakpoints || []).map(point => ({ ...point }));
        if (!asset.repeating && asset.breakpoints.length) asset.borderBase = [asset.width, asset.height];
        if (entry.repeat_layout) {
            asset.repeatLayout = structuredClone(entry.repeat_layout);
            asset.borderThickness = size;
            asset.width = Math.min(2000, size * 6); asset.height = Math.min(2000, size * 8);
        }
    }
    validateAsset(asset);
    return asset;
}

export function transformAsset(asset, matrix) {
    const result = { ...asset, matrix: transformMatrix(asset.matrix, matrix) };
    validateAsset(result);
    return result;
}

export function placedAsset(asset, original, object) {
    const matrix = placementMatrix(original, object);
    const placed = asset.repeatLayout ? { ...asset, matrix: transformMatrix(asset.matrix, matrix) } : transformAsset(asset, matrix);
    if (asset.repeatLayout) {
        const oldX = Math.hypot(asset.matrix[0], asset.matrix[1]), oldY = Math.hypot(asset.matrix[2], asset.matrix[3]);
        const sx = Math.hypot(placed.matrix[0], placed.matrix[1]), sy = Math.hypot(placed.matrix[2], placed.matrix[3]);
        const width = Math.max(1, Math.round(asset.width * sx)), height = Math.max(1, Math.round(asset.height * sy));
        const result = { ...placed, width, height, borderThickness: object.borderThickness ??
            asset.borderThickness * Math.min(oldX, oldY),
            matrix: asset.pixelGrid
                ? [placed.matrix[0] / sx, placed.matrix[1] / sx, placed.matrix[2] / sy, placed.matrix[3] / sy,
                    placed.matrix[4], placed.matrix[5]]
                : transformMatrix([asset.width / width, 0, 0, asset.height / height, 0, 0], placed.matrix) };
        validateAsset(result);
        return result;
    }
    if (!asset.borderBase) return placed;
    const sx = Math.hypot(placed.matrix[0], placed.matrix[1]);
    const sy = Math.hypot(placed.matrix[2], placed.matrix[3]);
    const width = Math.max(1, Math.round(asset.width * sx)), height = Math.max(1, Math.round(asset.height * sy));
    const result = { ...placed, width, height,
        matrix: transformMatrix([asset.width / width, 0, 0, asset.height / height, 0, 0], placed.matrix) };
    validateAsset(result);
    return result;
}

export function resizeBorder(asset, width, height) {
    if (!asset.borderBase && !asset.repeatLayout) throw new Error('This asset has no border layout recipe.');
    if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 2000)) {
        throw new Error('Border width and height must be whole cells from 1 to 2000.');
    }
    const result = { ...asset, width, height };
    validateAsset(result);
    if (result.repeatLayout) repeatingBorderPlan(result.repeatLayout, width, height, result.borderThickness);
    return result;
}

export function setBorderThickness(asset, thickness) {
    if (!asset.repeatLayout || !Number.isInteger(thickness) || thickness < 1 || thickness > 1000) {
        throw new Error('Select a repeating border and a thickness from 1 to 1000 cells.');
    }
    const result = { ...asset, borderThickness: thickness / Math.min(
        Math.hypot(asset.matrix[0], asset.matrix[1]), Math.hypot(asset.matrix[2], asset.matrix[3])) };
    validateAsset(result);
    repeatingBorderPlan(result.repeatLayout, result.width, result.height, result.borderThickness);
    return result;
}

export function borderThicknessLimit(asset) {
    validateRepeatLayout(asset.repeatLayout);
    if (![asset.width, asset.height].every(value => Number.isInteger(value) && value >= 1 && value <= 8192) ||
        !matrixValid(asset.matrix)) throw new Error('Invalid border frame dimensions or transform.');
    const sx = Math.hypot(asset.matrix[0], asset.matrix[1]), sy = Math.hypot(asset.matrix[2], asset.matrix[3]);
    const scale = Math.min(sx, sy);
    const corner = asset.repeatLayout.cornerSize ?? asset.repeatLayout.thickness;
    return Math.max(0, Math.floor(Math.min(1000,
        (asset.repeatLayout.maxThickness ?? 1000) * scale / Math.max(sx, sy),
        Math.min(asset.width, asset.height) * scale * asset.repeatLayout.thickness / (2 * corner)) + 1e-8));
}

function borderSegments(base, length, points) {
    if (!points.length) return [{ source: 0, sourceLength: base, start: 0, length }];
    const positions = points.map(point => point.position * base).sort((a, b) => a - b);
    const extra = (length - base) / positions.length, segments = [];
    let source = 0, start = 0;
    positions.forEach((position, index) => {
        const previous = index ? positions[index - 1] : 0, next = positions[index + 1] ?? base;
        const band = Math.min(1, position - previous, next - position);
        const end = position - band / 2, fixed = end - source;
        segments.push({ source, sourceLength: fixed, start, length: fixed });
        start += fixed;
        segments.push({ source: end, sourceLength: band, start, length: band + extra });
        source = end + band; start += band + extra;
    });
    segments.push({ source, sourceLength: base - source, start, length: base - source });
    return segments;
}

const pathsCache = new WeakMap();
const pixelCanvasCache = new WeakMap();
const pixelTileCache = new WeakMap();
export function rasterAsset(asset) {
    validateAsset(asset);
    const bounds = vectorBounds(asset);
    if (bounds.width > 8192 || bounds.height > 8192 || bounds.width * bounds.height > 4000000) throw new Error('Asset exceeds the 4 million-cell working area. Reduce its size.');
    const canvas = document.createElement('canvas');
    canvas.width = bounds.width; canvas.height = bounds.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const [a, b, c, d, e, f] = asset.matrix, [x, y, w, h] = asset.viewBox;
    const pixelAligned = asset.matrix.every(Number.isInteger) && Math.hypot(a, b) === 1 && Math.hypot(c, d) === 1;
    ctx.setTransform(a, b, c, d, e - bounds.x, f - bounds.y);
    let paths = pathsCache.get(asset.paths);
    if (!paths) { paths = asset.paths.map(path => new Path2D(path.d)); pathsCache.set(asset.paths, paths); }
    const paint = () => asset.paths.forEach((path, i) => {
        ctx.save(); ctx.transform(...path.matrix); ctx.fill(paths[i], path.fillRule); ctx.restore();
    });
    if (asset.repeatLayout) {
        let pixelCanvas = asset.pixelGrid && pixelCanvasCache.get(asset.pixelGrid);
        if (asset.pixelGrid && !pixelCanvas) {
            pixelCanvas = document.createElement('canvas');
            pixelCanvas.width = asset.pixelGrid[0].length; pixelCanvas.height = asset.pixelGrid.length;
            const pixelContext = pixelCanvas.getContext('2d');
            pixelContext.fillStyle = '#ffffff';
            asset.pixelGrid.forEach((row, y) => {
                for (let x = 0; x < row.length; x++) if (row[x] === '1') pixelContext.fillRect(x, y, 1, 1);
            });
            pixelCanvasCache.set(asset.pixelGrid, pixelCanvas);
        }
        ctx.imageSmoothingEnabled = false;
        const plan = repeatingBorderPlan(asset.repeatLayout, asset.width, asset.height, asset.borderThickness);
        const section = (source, left, top, width, height) => {
            if (width <= 0 || height <= 0) return;
            if (pixelCanvas) {
                const right = Math.round(left + width), bottom = Math.round(top + height);
                left = Math.round(left); top = Math.round(top);
                ctx.drawImage(pixelCanvas, ...source, left, top, right - left, bottom - top);
                return;
            }
            ctx.save();
            ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
            ctx.translate(left, top); ctx.scale(width / source[2], height / source[3]);
            ctx.translate(-source[0], -source[1]); paint(); ctx.restore();
        };
        for (const corner of plan.corners) {
            ctx.save(); ctx.transform(...corner.matrix);
            section(asset.repeatLayout.corner, 0, 0, plan.cornerSize, plan.cornerSize); ctx.restore();
        }
        for (const side of plan.sides) {
            ctx.save(); ctx.transform(...side.matrix);
            if (pixelCanvas && asset.repeatLayout.nativeRepeat && side.ornaments.gap === 0 &&
                side.ornaments.separators.length === side.ornaments.count + 1) {
                const source = asset.repeatLayout.nativeRepeat;
                const unit = source[2] / source[3] * plan.thickness;
                const count = Math.ceil(side.length / unit);
                if (count > 8192) throw new Error('Border has too many native repeats. Increase thickness.');
                ctx.beginPath(); ctx.rect(0, 0, side.length, plan.thickness); ctx.clip();
                for (let i = 0; i < count; i++) section(source, i * unit, 0, unit, plan.thickness);
                ctx.restore();
                continue;
            }
            const ornament = asset.repeatLayout.ornament;
            ctx.save();
            if (ornament?.edgeCuts?.length) {
                ctx.beginPath(); ctx.rect(0, 0, side.length, plan.thickness);
                for (const start of side.ornaments.starts) for (const cut of ornament.edgeCuts) {
                    ctx.rect(start + cut[0] * plan.scale, cut[1] * plan.scale,
                        cut[2] * plan.scale, cut[3] * plan.scale);
                }
                ctx.clip('evenodd');
            }
            for (const edge of asset.repeatLayout.edges) {
                const depth = edge.depth * plan.scale, offset = edge.offset * plan.scale;
                const unit = edge.source[2] / edge.source[3] * depth;
                if (edge.mode === 'stretch') section(edge.source, 0, offset, side.length, depth);
                else {
                    const half = side.length / 2, count = Math.ceil(half / unit);
                    if (count > 8192) throw new Error('Border has too many edge repeats. Increase thickness or use a stretch strip.');
                    // Anchor repeat phase at each corner; any partial tile stays at the center seam.
                    for (const end of [false, true]) {
                        ctx.save();
                        if (end) { ctx.translate(side.length, 0); ctx.scale(-1, 1); }
                        ctx.beginPath(); ctx.rect(0, 0, half, plan.thickness); ctx.clip();
                        const cuts = edge.phaseAfterCut === undefined ? [] :
                            side.ornaments.starts.flatMap(start => (ornament.edgeCuts || [])
                                .filter(cut => cut[1] < edge.offset + edge.depth && cut[1] + cut[3] > edge.offset)
                                .map(cut => {
                                    const left = start + cut[0] * plan.scale, length = cut[2] * plan.scale;
                                    return { start: end ? side.length - left - length : left, length };
                                })).sort((a, b) => a.start - b.start);
                        let start = 0, phase = 0;
                        for (const cut of [...cuts, { start: half, length: 0 }]) {
                            const stop = Math.min(half, cut.start);
                            if (stop > start) {
                                ctx.save(); ctx.beginPath(); ctx.rect(start, offset, stop - start, depth); ctx.clip();
                                if (pixelCanvas && pixelAligned && [unit, depth, start, phase, offset].every(Number.isInteger) &&
                                    unit * depth <= 1000000) {
                                    let tiles = pixelTileCache.get(asset.pixelGrid);
                                    if (!tiles) { tiles = new Map(); pixelTileCache.set(asset.pixelGrid, tiles); }
                                    const key = [...edge.source, unit, depth].join();
                                    let tile = tiles.get(key);
                                    if (!tile) {
                                        tile = document.createElement('canvas'); tile.width = unit; tile.height = depth;
                                        const tileContext = tile.getContext('2d');
                                        tileContext.imageSmoothingEnabled = false;
                                        tileContext.drawImage(pixelCanvas, ...edge.source, 0, 0, unit, depth);
                                        if (tiles.size >= 16) tiles.delete(tiles.keys().next().value);
                                        tiles.set(key, tile);
                                    }
                                    const pattern = ctx.createPattern(tile, 'repeat');
                                    if (!pattern) throw new Error('Could not render the pixel-border strip.');
                                    ctx.translate(start - phase, offset); ctx.fillStyle = pattern;
                                    ctx.fillRect(phase, 0, stop - start, depth);
                                } else {
                                    const repeats = Math.ceil((stop - start + phase) / unit);
                                    for (let i = 0; i < repeats; i++) section(edge.source, start - phase + i * unit, offset, unit, depth);
                                }
                                ctx.restore();
                            }
                            start = Math.max(start, cut.start + cut.length);
                            phase = (edge.phaseAfterCut ?? 0) * plan.scale;
                            if (start >= half) break;
                        }
                        ctx.restore();
                    }
                }
            }
            ctx.restore();
            if (ornament?.separator) for (const start of side.ornaments.separators) {
                section(ornament.separator.source, start, ornament.separator.offset * plan.scale,
                    side.separatorUnit, ornament.separator.depth * plan.scale);
            }
            if (ornament) for (const start of side.ornaments.starts) {
                section(ornament.source, start, ornament.offset * plan.scale, side.unit, ornament.depth * plan.scale);
            }
            ctx.restore();
        }
    } else if (asset.borderBase) {
        // Fit original SVG proportions to the physical box, never to the preview's base size.
        const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
        const scale = Math.min(asset.width * sx / w, asset.height * sy / h);
        const bw = w * scale / sx, bh = h * scale / sy;
        const horizontal = borderSegments(bw, asset.width, asset.breakpoints.filter(point => point.axis === 'x'));
        const vertical = borderSegments(bh, asset.height, asset.breakpoints.filter(point => point.axis === 'y'));
        for (const column of horizontal) for (const row of vertical) {
            ctx.save();
            ctx.beginPath(); ctx.rect(column.start, row.start, column.length, row.length); ctx.clip();
            ctx.translate(column.start, row.start);
            ctx.scale(column.length / column.sourceLength, row.length / row.sourceLength);
            ctx.translate(-column.source, -row.source);
            ctx.scale(bw / w, bh / h); ctx.translate(-x, -y);
            paint(); ctx.restore();
        }
    } else {
        ctx.scale(asset.width / w, asset.height / h); ctx.translate(-x, -y); paint();
    }
    if (asset.pixelGrid) {
        ctx.globalCompositeOperation = 'source-in';
        ctx.resetTransform(); ctx.fillStyle = asset.color; ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const entries = [];
    let empty = null;
    if (asset.repeatLayout && ((b === 0 && c === 0) || (a === 0 && d === 0))) {
        const inset = (asset.repeatLayout.cornerSize ?? asset.repeatLayout.thickness) *
            asset.borderThickness / asset.repeatLayout.thickness;
        const points = [[inset, inset], [asset.width - inset, asset.height - inset]]
            .map(([px, py]) => [a * px + c * py + e - bounds.x, b * px + d * py + f - bounds.y]);
        empty = { left: Math.ceil(Math.min(...points.map(p => p[0]))),
            right: Math.floor(Math.max(...points.map(p => p[0]))),
            top: Math.ceil(Math.min(...points.map(p => p[1]))),
            bottom: Math.floor(Math.max(...points.map(p => p[1]))) };
    }
    const regions = (empty && empty.right > empty.left && empty.bottom > empty.top ? [
        { x: 0, y: 0, width: canvas.width, height: empty.top },
        { x: 0, y: empty.top, width: empty.left, height: empty.bottom - empty.top },
        { x: empty.right, y: empty.top, width: canvas.width - empty.right, height: empty.bottom - empty.top },
        { x: 0, y: empty.bottom, width: canvas.width, height: canvas.height - empty.bottom },
    ] : [{ x: 0, y: 0, width: canvas.width, height: canvas.height }])
        .filter(region => region.width > 0 && region.height > 0)
        .map(region => ({ ...region, data: ctx.getImageData(region.x, region.y, region.width, region.height).data }));
    for (let y = 0; y < canvas.height; y++) {
        for (const region of regions) {
            if (y < region.y || y >= region.y + region.height) continue;
            const row = (y - region.y) * region.width;
            for (let x = 0; x < region.width; x++) {
                if (region.data[(row + x) * 4 + 3] >= 128) entries.push([bounds.x + region.x + x, bounds.y + y, asset.color]);
            }
        }
    }
    return entries;
}

export function assetThumbnail(source) {
    if (source.repeatLayout) {
        const asset = { ...source, name: 'Border preview', file: 'preview.svg', kind: 'border', repeating: true,
            width: 60, height: 80, borderThickness: 10, color: '#000000', matrix: [...identity] };
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 60 80'); svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', rasterAsset(asset).map(([x, y]) => `M${x} ${y}h1v1h-1Z`).join(' '));
        path.setAttribute('fill', 'currentColor'); svg.append(path);
        return svg;
    }
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
