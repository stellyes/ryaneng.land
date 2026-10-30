import { BLEND_MODES, blendPixel, pixelColor, pixelWord, layerSeed, dissolveNoise } from './blending.js';
import { validateText, textBounds, rasterText, transformText } from './text.js';
export { BLEND_MODES } from './blending.js';
export const LOCKS = ['transparency', 'color', 'position', 'all'];
export const MAX_LAYERS = 64;
export const MAX_LAYER_CELLS = 4000000;

export function* layerPixels(project, layer) {
    for (let i = 0; i < layer.cells.length; i++) {
        if (layer.cells[i] !== null) yield [i % project.cols, Math.floor(i / project.cols), layer.cells[i]];
    }
    yield* layer.offCanvas || [];
}

export function layerRaster(project, entries) {
    const cells = Array(project.cols * project.rows).fill(null), outside = new Map();
    for (const [x, y, color] of entries) {
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new Error('Layer coordinates must be safe whole-cell positions.');
        if (x >= 0 && y >= 0 && x < project.cols && y < project.rows) cells[y * project.cols + x] = color;
        else outside.set(`${x},${y}`, [x, y, color]);
    }
    return { cells, offCanvas: [...outside.values()] };
}

export function checkLayerMemory(project, layers = project.layers) {
    const size = layers.reduce((n, layer) => n + (layer.type === 'layer' ? project.cols * project.rows + (layer.offCanvas?.length || 0) : 0), 0);
    if (size > MAX_LAYER_CELLS) throw new Error('This edit exceeds the 4 million layer-cell memory limit, including off-canvas pixels.');
}

export function translateLayer(project, layer, dx, dy) {
    if (layer.text) {
        const text = transformText(layer.text, [1, 0, 0, 1, dx, dy]);
        return { ...layerRaster(project, rasterText(text)), text };
    }
    return layerRaster(project, [...layerPixels(project, layer)].map(([x, y, color]) => [x + dx, y + dy, color]));
}

export function alignmentPlan(project, mode) {
    if (!['left', 'center-x', 'right', 'top', 'center-y', 'bottom'].includes(mode)) throw new Error('Invalid alignment.');
    const ids = new Set(selectedPixels(project).map(layer => layer.id));
    const layers = layerOrder(project).filter(layer => ids.has(layer.id) &&
        (layer.cells.some(color => color !== null) || layer.offCanvas?.length));
    if (layers.length < 2) throw new Error('Select multiple layers');
    const anchor = layerBounds(project, layers.at(-1)), horizontal = ['left', 'center-x', 'right'].includes(mode);
    const edge = bounds => horizontal
        ? mode === 'left' ? bounds.x : mode === 'right' ? bounds.x + bounds.width : bounds.x + bounds.width / 2
        : mode === 'top' ? bounds.y : mode === 'bottom' ? bounds.y + bounds.height : bounds.y + bounds.height / 2;
    const moves = layers.map(layer => {
        const distance = edge(anchor) - edge(layerBounds(project, layer));
        if (distance !== 0 && !canTransform(layer)) throw new Error('Unlock the position of every layer that needs to move before aligning.');
        return { id: layer.id, dx: horizontal ? Math.round(distance) : 0, dy: horizontal ? 0 : Math.round(distance), fractional: !Number.isInteger(distance) };
    });
    return { moves, needsApproval: moves.some(move => move.fractional) };
}

export function alignLayers(project, mode, approveRounding = false) {
    const plan = alignmentPlan(project, mode);
    if (plan.needsApproval && !approveRounding) throw new Error('Exact centering requires half a cell. Approval is required to round toward the right/bottom.');
    const moved = new Map(plan.moves.filter(move => move.dx || move.dy).map(move => [
        move.id, translateLayer(project, project.layers.find(layer => layer.id === move.id), move.dx, move.dy),
    ]));
    if (!moved.size) return false;
    const layers = project.layers.map(layer => moved.has(layer.id) ? { ...layer, ...moved.get(layer.id) } : layer);
    checkLayerMemory(project, layers);
    project.layers = layers;
    bindLayer(project);
    return true;
}

export function newLayer(cols, rows, name = 'Layer 1', cells = null) {
    return {
        id: crypto.randomUUID(), type: 'layer', name, parentId: null, visible: true,
        blendMode: 'Normal', opacity: 1, locks: { transparency: false, color: false, position: false, all: false },
        cells: cells ? cells.slice() : Array(cols * rows).fill(null),
    };
}

export function activeLayer(project) {
    return project?.layers?.find(layer => layer.id === project.activeLayerId) || null;
}

// cells is a live alias of the active layer in the editor; serialized cells is
// a flattened compatibility preview. Layer pixels are always the source of truth.
export function bindLayer(project) {
    const ids = new Set(project.layers.map(layer => layer.id));
    project.selectedLayerIds = (project.selectedLayerIds || [project.activeLayerId]).filter(id => ids.has(id));
    if (!project.selectedLayerIds.includes(project.activeLayerId)) project.selectedLayerIds.push(project.activeLayerId);
    const layer = activeLayer(project);
    project.cells = layer?.type === 'layer' ? layer.cells : Array(project.cols * project.rows).fill(null);
}

export function selectedLayers(project, rootsOnly = false) {
    const ids = new Set(project.selectedLayerIds || [project.activeLayerId]);
    return layerOrder(project).filter(layer => ids.has(layer.id) &&
        (!rootsOnly || !layerAncestors(project, layer).some(parent => ids.has(parent.id))));
}

export function selectedPixels(project) {
    const ids = new Set(project.selectedLayerIds || [project.activeLayerId]);
    return project.layers.filter(layer => layer.type === 'layer' &&
        (ids.has(layer.id) || layerAncestors(project, layer).some(parent => ids.has(parent.id))));
}

export function editLayerSelection(project, action, drop = {}) {
    const roots = selectedLayers(project, true);
    if (!roots.length) throw new Error('Select at least one layer or folder.');
    const pixels = selectedPixels(project);
    if (pixels.some(layer => layer.locks.all)) throw new Error('Unlock all selected layers before changing their stack.');
    const work = { ...project, layers: project.layers.map(layer => ({ ...layer })) };
    const ids = roots.map(layer => layer.id);
    if (action === 'delete') {
        const selected = selectedLayers(project);
        for (const layer of selected.filter(layer => layer.type === 'layer')) deleteLayer(work, layer.id);
        for (const layer of selected.filter(layer => layer.type === 'folder').reverse()) deleteLayer(work, layer.id);
        work.selectedLayerIds = [work.activeLayerId];
    } else if (action === 'copy') {
        const copies = [];
        for (const root of roots) {
            const block = layerOrder(work).filter(layer => layer.id === root.id || layerAncestors(work, layer).some(parent => parent.id === root.id));
            const replacements = new Map(block.map(layer => [layer.id, crypto.randomUUID()]));
            const cloned = block.map(layer => {
                layerRoom(work, layer.type === 'layer');
                const copy = { ...layer, id: replacements.get(layer.id),
                    parentId: replacements.get(layer.parentId) || layer.parentId,
                    name: layer.id === root.id ? layer.name.slice(0, 75) + ' copy' : layer.name };
                if (layer.type === 'layer') {
                    copy.cells = layer.cells.slice(); copy.offCanvas = structuredClone(layer.offCanvas || []); copy.locks = { ...layer.locks };
                    if (layer.text) copy.text = structuredClone(layer.text);
                }
                work.layers.push(copy);
                return copy;
            });
            const ordered = layerOrder(work).filter(layer => !cloned.includes(layer));
            ordered.splice(ordered.findIndex(layer => layer.id === root.id), 0, ...cloned);
            work.layers = ordered;
            copies.push(cloned[0].id);
        }
        work.selectedLayerIds = copies;
        work.activeLayerId = copies[0];
    } else if (action === 'folder') {
        layerRoom(work, false);
        const first = roots[0];
        const folder = { id: crypto.randomUUID(), type: 'folder', name: first.name.slice(0, 73) + ' folder',
            parentId: first.parentId, visible: true, expanded: true };
        const ordered = layerOrder(work);
        ordered.splice(ordered.findIndex(layer => layer.id === first.id), 0, folder);
        work.layers = ordered;
        for (const id of [...ids].reverse()) moveLayer(work, id, folder.id, 'inside');
        work.selectedLayerIds = ids;
    } else if (action === 'up' || action === 'down') {
        let changed = false;
        const delta = action === 'up' ? -1 : 1;
        for (const root of delta < 0 ? roots : [...roots].reverse()) {
            const siblings = layerOrder(work).filter(layer => layer.parentId === root.parentId);
            const neighbor = siblings[siblings.findIndex(layer => layer.id === root.id) + delta];
            if (neighbor && !ids.includes(neighbor.id)) {
                changed = moveLayer(work, root.id, neighbor.id, delta < 0 ? 'before' : 'after', root.parentId) || changed;
            }
        }
        if (!changed) return false;
    } else if (action === 'move') {
        const target = work.layers.find(layer => layer.id === drop.target);
        if (target && (ids.includes(target.id) || layerAncestors(work, target).some(parent => ids.includes(parent.id)))) return false;
        let changed = false;
        for (const id of drop.position === 'before' ? ids : [...ids].reverse()) {
            changed = moveLayer(work, id, drop.target, drop.position, drop.parentId) || changed;
        }
        if (!changed) return false;
    } else throw new Error('Invalid multi-layer action.');
    checkLayerMemory(project, work.layers);
    project.layers = work.layers;
    project.activeLayerId = work.activeLayerId;
    project.selectedLayerIds = work.selectedLayerIds;
    return true;
}

export function migrateLayers(project) {
    if (!project.layers) {
        const layer = newLayer(project.cols, project.rows, 'Layer 1', project.cells);
        project.layers = [layer];
        project.activeLayerId = layer.id;
    }
    for (const layer of project.layers) if (layer.type === 'layer' && layer.opacity === undefined) layer.opacity = 1;
    project.version = 2;
    bindLayer(project);
    return project;
}

export function layerOrder(project) {
    const ordered = [];
    const visit = parentId => {
        for (const layer of project.layers.filter(item => item.parentId === parentId)) {
            ordered.push(layer);
            if (layer.type === 'folder') visit(layer.id);
        }
    };
    visit(null);
    return ordered;
}

export function layerAncestors(project, layer) {
    const ancestors = [], seen = new Set([layer.id]);
    while (layer.parentId !== null) {
        const parent = project.layers.find(item => item.id === layer.parentId);
        if (!parent || parent.type !== 'folder' || seen.has(parent.id)) throw new Error('Invalid project layer hierarchy.');
        ancestors.push(parent);
        seen.add(parent.id);
        layer = parent;
    }
    return ancestors;
}

export function layerVisible(project, layer) {
    return layer.visible && layerAncestors(project, layer).every(parent => parent.visible);
}

export function moveLayer(project, id, targetId = null, position = 'after', parentId = null) {
    const layer = project.layers.find(item => item.id === id);
    const target = targetId === null ? null : project.layers.find(item => item.id === targetId);
    if (!layer || (targetId !== null && !target) || !['before', 'after', 'inside'].includes(position)) {
        throw new Error('Invalid layer drop target.');
    }
    if (layer.id === targetId) return false;
    if (layer.type === 'layer' && layer.locks.all) throw new Error('Unlock this layer before reordering it.');
    if (position === 'inside') {
        if (target?.type !== 'folder') throw new Error('Drop onto a folder to group layers.');
        parentId = target.id;
    }
    if (parentId !== null && !project.layers.some(item => item.id === parentId && item.type === 'folder')) {
        throw new Error('Choose an existing folder for this layer.');
    }
    const ordered = layerOrder(project);
    const moving = ordered.filter(item => item === layer || layerAncestors(project, item).includes(layer));
    if (moving.includes(target)) return false;
    if (moving.some(item => item.id === parentId)) throw new Error('A folder cannot contain itself or its ancestors.');
    if (position !== 'inside' && parentId !== (target ? target.parentId : null)) {
        throw new Error('Drop between layers in the same folder, or beside a top-level row to ungroup.');
    }
    const remaining = ordered.filter(item => !moving.includes(item));
    let index = remaining.length;
    if (target) {
        index = remaining.indexOf(target);
        if (position === 'inside') index++;
        else if (position === 'after') {
            index++;
            if (target.type === 'folder') while (index < remaining.length && layerAncestors(project, remaining[index]).includes(target)) index++;
        }
    }
    const next = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
    if (layer.parentId === parentId && next.every((item, i) => ordered[i] === item)) return false;
    layer.parentId = parentId;
    if (parentId) project.layers.find(item => item.id === parentId).expanded = true;
    project.layers = next;
    return true;
}

export function layerRoom(project, addingLayer) {
    if (project.layers.length >= MAX_LAYERS ||
        (addingLayer && project.layers.reduce((n, layer) => n + (layer.type === 'layer' ? project.cols * project.rows + (layer.offCanvas?.length || 0) : 0), project.cols * project.rows) > MAX_LAYER_CELLS)) {
        throw new Error('Layer limit reached (64 entries or 4 million layer cells). Remove layers or reduce the grid size.');
    }
}

export function deleteLayer(project, id) {
    const current = project.layers.find(layer => layer.id === id);
    if (!current) throw new Error('Choose an existing layer to delete.');
    if (current.type === 'layer') {
        if (current.locks.all) throw new Error('Unlock this layer before deleting it.');
        if (project.layers.filter(layer => layer.type === 'layer').length === 1) throw new Error('Keep at least one layer in the project.');
    }
    const ordered = layerOrder(project);
    project.layers.forEach(layer => { if (layer.parentId === id) layer.parentId = current.parentId; });
    project.layers = ordered.filter(layer => layer !== current);
    if (project.activeLayerId === id) project.activeLayerId = project.layers.find(layer => layer.type === 'layer').id;
    project.selectedLayerIds = (project.selectedLayerIds || []).filter(selected => selected !== id);
    if (!project.selectedLayerIds.includes(project.activeLayerId)) project.selectedLayerIds.push(project.activeLayerId);
}

export function layerDropAction(project, id, action) {
    if (action === 'delete') { deleteLayer(project, id); return; }
    const source = project.layers.find(layer => layer.id === id);
    if (!source || source.type !== 'layer') throw new Error('Drag a pixel layer onto this icon.');
    if (!['copy', 'folder'].includes(action)) throw new Error('Invalid layer drop action.');
    if (source.locks.all) throw new Error('Unlock this layer before dragging it.');
    layerRoom(project, action === 'copy');
    const ordered = layerOrder(project), index = ordered.indexOf(source);
    const suffix = action === 'copy' ? ' copy' : ' folder';
    const name = source.name.slice(0, 80 - suffix.length) + suffix;
    const entry = action === 'copy'
        ? { ...source, id: crypto.randomUUID(), name, cells: source.cells.slice(), offCanvas: structuredClone(source.offCanvas || []), locks: { ...source.locks },
            ...(source.text ? { text: structuredClone(source.text) } : {}) }
        : { id: crypto.randomUUID(), type: 'folder', name, parentId: source.parentId, visible: true, expanded: true };
    ordered.splice(index, 0, entry);
    if (action === 'folder') source.parentId = entry.id;
    project.layers = ordered;
    project.activeLayerId = action === 'copy' ? entry.id : source.id;
    project.selectedLayerIds = [project.activeLayerId];
}

export function createLayerCompositor(project, preview = null, replacing = false,
    ordered = layerOrder(project).filter(layer => layer.type === 'layer' && layerVisible(project, layer))) {
    const colors = new Map(), transparent = [0, 0, 0, 0];
    const entries = ordered.map(layer => ({
        layer, opacity: layer.opacity ?? 1, seed: layerSeed(layer.id), cache: new Map(), size: 0,
    }));
    function sourceColor(layer, index) {
        let color = layer.cells[index];
        if (layer.id === project.activeLayerId && preview) {
            if (replacing) color = preview.get(index) ?? null;
            else if (preview.has(index) && canWrite(layer, layer.cells[index]) &&
                !(layer.locks.transparency && preview.get(index) === null)) color = preview.get(index);
        }
        if (color === null) return null;
        let pixel = colors.get(color);
        if (!pixel) {
            pixel = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16) / 255);
            pixel.push(1);
            colors.set(color, pixel);
        }
        return pixel;
    }
    return index => {
        let bottom = entries.length - 1;
        let output = transparent;
        // An opaque Normal/Dissolve pixel completely occludes the layers below it.
        for (let i = 0; i < entries.length; i++) {
            const { layer, opacity, seed } = entries[i];
            if (!opacity) continue;
            const source = sourceColor(layer, index);
            if (!source) continue;
            if ((layer.blendMode === 'Normal' && opacity === 1) ||
                (layer.blendMode === 'Dissolve' && dissolveNoise(seed, index) < opacity)) {
                output = source;
                bottom = i - 1;
                break;
            }
        }
        for (let i = bottom; i >= 0; i--) {
            const entry = entries[i], { layer, opacity, seed } = entry;
            if (!opacity) continue;
            const source = sourceColor(layer, index);
            if (!source) continue;
            const effectiveOpacity = layer.blendMode === 'Dissolve' ? Number(dissolveNoise(seed, index) < opacity) : opacity;
            if (!effectiveOpacity) continue;
            let cache = entry.cache.get(output);
            const cached = cache?.get(source);
            if (cached) { output = cached; continue; }
            if (entry.size >= 1024) { entry.cache.clear(); entry.size = 0; cache = null; }
            if (!cache) { cache = new Map(); entry.cache.set(output, cache); }
            const result = blendPixel(output, source, layer.blendMode, effectiveOpacity);
            cache.set(source, result);
            entry.size++;
            output = result;
        }
        return output[3] === 0 ? null : output;
    };
}

export function compositeColor(project, index, preview = null, replacing = false, ordered) {
    return pixelColor(createLayerCompositor(project, preview, replacing, ordered)(index), true);
}

export function flattenLayers(project) {
    if (!project.layers) return project.cells;
    const composite = createLayerCompositor(project);
    const colors = new WeakMap();
    return Array.from({ length: project.cols * project.rows }, (_, index) => {
        const pixel = composite(index);
        if (!pixel) return null;
        if (!colors.has(pixel)) colors.set(pixel, pixelColor(pixel, true));
        return colors.get(pixel);
    });
}

export function flattenPixels(project) {
    const pixels = new Uint32Array(project.cols * project.rows);
    if (!project.layers) {
        project = migrateLayers({ ...project });
    }
    const composite = createLayerCompositor(project);
    const words = new WeakMap();
    for (let i = 0; i < pixels.length; i++) {
        const pixel = composite(i);
        if (!pixel) continue;
        if (!words.has(pixel)) words.set(pixel, pixelWord(pixel));
        pixels[i] = words.get(pixel);
    }
    return pixels;
}

export function serializeLayers(project) {
    return { ...project, cells: flattenLayers(project) };
}

export function canWrite(layer, oldColor) {
    if (!layer || layer.type !== 'layer' || layer.text || layer.locks.all) return false;
    if (layer.locks.transparency && oldColor === null) return false;
    if (layer.locks.color && oldColor !== null) return false;
    return true;
}

export function writeLayerCell(layer, index, color) {
    if (!canWrite(layer, layer.cells[index]) || (layer.locks.transparency && color === null) || layer.cells[index] === color) return false;
    layer.cells[index] = color;
    return true;
}

export function canTransform(layer) {
    return Boolean(layer?.type === 'layer' && !layer.locks.all && !layer.locks.position);
}

export function layerBounds(project, layer) {
    if (layer.text) return textBounds(layer.text);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of layerPixels(project, layer)) {
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    if (!Number.isFinite(left)) return { x: 0, y: 0, width: project.cols, height: project.rows };
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export function transformLayers(project, transform, cols, rows, mapPoint = (x, y) => [x, y], textMatrix) {
    if (project.layers.filter(layer => layer.type === 'layer').length * cols * rows > MAX_LAYER_CELLS) {
        throw new Error('This grid would exceed the 4 million layer-cell memory limit. Reduce the grid size or remove layers.');
    }
    const layers = project.layers.map(layer => {
        if (layer.type !== 'layer') return layer;
        if (layer.text) {
            const origin = mapPoint(0, 0), x = mapPoint(1, 0), y = mapPoint(0, 1);
            const a = x[0] - origin[0], b = x[1] - origin[1], c = y[0] - origin[0], d = y[1] - origin[1];
            const text = transformText(layer.text, textMatrix || [a, b, c, d, origin[0] + 0.5 - (a + c) / 2, origin[1] + 0.5 - (b + d) / 2]);
            return { ...layer, text, ...layerRaster({ cols, rows }, rasterText(text)) };
        }
        const cells = transform(layer.cells);
        const extra = (layer.offCanvas || []).map(([x, y, color]) => [...mapPoint(x, y), color]);
        const raster = layerRaster({ cols, rows }, extra);
        raster.cells.forEach((color, i) => { if (color !== null) cells[i] = color; });
        return { ...layer, cells, offCanvas: raster.offCanvas };
    });
    checkLayerMemory({ cols, rows }, layers);
    project.layers = layers;
    project.cols = cols;
    project.rows = rows;
    bindLayer(project);
}

export function validateLayers(data) {
    const invalid = () => { throw new Error('Invalid project layer data.'); };
    if (!Array.isArray(data.layers) || !data.layers.length || data.layers.length > MAX_LAYERS) invalid();
    const ids = new Set(), size = data.cols * data.rows;
    let count = 0;
    for (const layer of data.layers) {
        if (!layer || typeof layer.id !== 'string' || !layer.id || ids.has(layer.id) ||
            !['layer', 'folder'].includes(layer.type) || typeof layer.name !== 'string' ||
            !layer.name.trim() || layer.name.length > 80 || typeof layer.visible !== 'boolean' ||
            !(layer.parentId === null || typeof layer.parentId === 'string')) invalid();
        ids.add(layer.id);
        if (layer.type === 'folder') {
            if (layer.text !== undefined) invalid();
            if (typeof layer.expanded !== 'boolean') invalid();
            continue;
        }
        count++;
        if (layer.text !== undefined) validateText(layer.text);
        if (layer.offCanvas !== undefined) {
            if (!Array.isArray(layer.offCanvas) || layer.offCanvas.length > MAX_LAYER_CELLS) invalid();
            const positions = new Set();
            for (const pixel of layer.offCanvas) {
                if (!Array.isArray(pixel) || pixel.length !== 3) invalid();
                const [x, y, color] = pixel, key = `${x},${y}`;
                if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
                    (x >= 0 && y >= 0 && x < data.cols && y < data.rows) || positions.has(key) ||
                    typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) invalid();
                positions.add(key);
            }
        }
        if (!BLEND_MODES.includes(layer.blendMode) ||
            (layer.opacity !== undefined && (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1)) || !layer.locks ||
            !LOCKS.every(key => typeof layer.locks[key] === 'boolean') ||
            !Array.isArray(layer.cells) || layer.cells.length !== size ||
            !layer.cells.every(color => color === null || (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)))) invalid();
    }
    if (!count || count * size + data.layers.reduce((n, layer) => n + (layer.offCanvas?.length || 0), 0) > MAX_LAYER_CELLS || !ids.has(data.activeLayerId)) invalid();
    if (data.selectedLayerIds !== undefined && (!Array.isArray(data.selectedLayerIds) ||
        !data.selectedLayerIds.length || data.selectedLayerIds.length > MAX_LAYERS ||
        new Set(data.selectedLayerIds).size !== data.selectedLayerIds.length ||
        !data.selectedLayerIds.every(id => ids.has(id)) || !data.selectedLayerIds.includes(data.activeLayerId))) invalid();
    for (const layer of data.layers) {
        if (layer.parentId !== null && !data.layers.some(parent => parent.id === layer.parentId && parent.type === 'folder')) invalid();
        layerAncestors(data, layer);
    }
}
