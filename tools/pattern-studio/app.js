import { MAX_SIDE, parseGridSize, gridDimensions, resizeCells, cropCells, extendCells, mirrorCells, rotateCells, referenceRect, extendBoard, mirrorBoard, rotateBoard, flood, line, validateProject, openStore } from './model.js';
import { CROP_RATIOS, fitCrop, moveCrop, resizeCrop } from './crop.js';
import { createPlacementEditor } from './placement.js';
import { MAX_STROKE, brush, brushBounds, strokeWidth } from './objects.js';
import { USABLE_SCORE, CUSTOM_MIX, closestYarn, colorUsage, findClosestColor, matchCustomMix, matchYarnLine, prepareYarnLines, rankYarnLines } from './palette.js';
import { createImportPreview } from './import-preview.js';
import { activeLayer, bindLayer, migrateLayers, serializeLayers, flattenLayers, layerOrder, layerVisible,
    createLayerCompositor, flattenPixels, canWrite, writeLayerCell, canTransform, transformLayers,
    layerRaster, layerPixels, checkLayerMemory, newLayer, layerRoom } from './layers.js';
import { createLayerPanel } from './layer-panel.js';
import { pixelColor, pixelWord } from './blending.js';
import { showGrid, createTransparencyPattern, canvasLayout, stepZoom, MIN_ZOOM, MAX_ZOOM } from './display.js';
import { adjustBrush } from './adjustments.js';
import { fontCatalog, loadSvgFont, layoutText, rasterText, fontNamePreview } from './text.js';

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const context = canvas.getContext('2d');
const transparencyPattern = createTransparencyPattern(context);
let paintedGridVisible = false;
const largeScreen = matchMedia('(min-width: 768px)');
let project = null;
let reference = null;
const sampleCanvas = document.createElement('canvas');
const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
let selected = null;
let tool = 'paint';
let history = [];
let future = [];
let stroke = null;
let pan = null;
let cursor = { x: 0, y: 0 };
let keyboardFocus = false;
let pointerFocus = false;
let brushPointer = null;
let spaceHeld = false, pointerOverWorkspace = false;
let timer;
let dirty = false;
let revision = 0;
let saveQueue = Promise.resolve();
let store = null;
let storageError = null;
let zoom = 1;
let crop = null;
let cropDrag = null;
let settingsPanel = null;
let textEditGeneration = 0;
let creatingText = false;
let textPanelLayerId = null;
const STROKE_KEY = 'pattern-studio-stroke-widths';
const strokeWidths = { paint: 1, erase: 1, line: 1, shape: 1, dodge: 1, burn: 1, sponge: 1 };
const adjustmentTools = ['dodge', 'burn', 'sponge'];
const adjustmentSettings = {
    dodge: { intensity: 50, range: 'midtones' },
    burn: { intensity: 50, range: 'midtones' },
    sponge: { intensity: 50, mode: 'saturate' },
};
try {
    const saved = JSON.parse(localStorage.getItem(STROKE_KEY) || '{}');
    for (const key of Object.keys(strokeWidths)) strokeWidths[key] = strokeWidth(saved[key]);
} catch { /* Widths fall back to 1 when storage is unavailable. */ }
const placement = createPlacementEditor({
    canvas, getProject: () => project, getColor: () => selected, getStroke: kind => strokeWidths[kind],
    getSnapping: () => $('snapping-toggle').checked,
    canTransform: () => canTransform(activeLayer(project)),
    redraw: () => renderPlacement(), updateControls, notify,
    commitLayerPixels(entries, erase = false, text = null) {
        const layer = activeLayer(project);
        if (!layerVisible(project, layer)) throw new Error('Show this layer and its folders before editing.');
        if (!erase && !canTransform(layer)) throw new Error('Unlock this layer position before transforming.');
        if (layer.text && !text) throw new Error('Text layers must be edited as text, not painted pixels.');
        const remaining = erase ? [...layerPixels(project, layer)].filter(([, , color]) =>
            !canWrite(layer, color) || layer.locks.transparency) : entries;
        const raster = layerRaster(project, remaining);
        if (raster.cells.every((color, i) => layer.cells[i] === color) &&
            JSON.stringify(raster.offCanvas) === JSON.stringify(layer.offCanvas || []) &&
            (!text || JSON.stringify(text.matrix) === JSON.stringify(layer.text.matrix))) return false;
        checkLayerMemory(project, project.layers.map(item => item === layer ? { ...item, ...raster } : item));
        remember(snapshot());
        Object.assign(layer, raster);
        if (text) layer.text = text;
        bindLayer(project);
        changed();
        return true;
    },
    commitPixels(pixels, replace = false) {
        const layer = activeLayer(project);
        if (!project || layer?.type !== 'layer') { notify('Select a pixel layer before editing.', true); return false; }
        if (layer.text) { notify('Choose a paint layer before painting or pasting. Edit text in Tool options.', true); return false; }
        if (!layerVisible(project, layer)) { notify('Show this layer and its folder before editing.', true); return false; }
        if (replace && !canTransform(layer)) { notify('This layer is position-locked.', true); return false; }
        const changes = replace
            ? new Map(layer.cells.map((color, index) => [index, pixels.get(index) ?? null]).filter(([index, color]) => layer.cells[index] !== color))
            : new Map([...pixels].filter(([index, color]) => canWrite(layer, layer.cells[index]) &&
                !(layer.locks.transparency && color === null) && layer.cells[index] !== color));
        if (!changes.size) {
            if (pixels.size && !replace && (layer.locks.all || layer.locks.color || layer.locks.transparency)) {
                notify('No pixels changed: this edit is blocked by the layer locks.', true);
            }
            return false;
        }
        remember(snapshot());
        for (const [index, color] of changes) layer.cells[index] = color;
        changed();
        return true;
    },
});
const layerPanel = createLayerPanel({
    getProject: () => project, remember, snapshot, changed, redraw: () => render(), notify,
    beforeEdit() {
        if (crop) { notify('Apply or cancel the crop before editing layers.', true); return false; }
        finishPan(); finishStroke();
        return placement.commit() !== false;
    },
    select() {
        placement.selectLayers();
    },
});

function notify(text, error = false) {
    $('message').textContent = text;
    $('message').classList.toggle('error', error);
    document.querySelectorAll('dialog[open] .dialog-message').forEach(message => {
        message.textContent = text;
        message.classList.toggle('error', error);
    });
}

function report(error) {
    console.error('Pattern Studio:', error);
    notify(error.message || 'The operation failed. Please try again.', true);
}

function action(id, handler) {
    $(id).addEventListener('click', () => Promise.resolve().then(() => {
        finishPan();
        finishStroke();
        if (!['undo', 'redo', 'zoom-in', 'zoom-out', 'add-color', 'delete-color', 'copy', 'cut', 'paste', 'upload', 'new-project', 'new-image'].includes(id)) placement.commit();
    }).then(handler).catch(report));
}
for (const [menuId, toggleId, actionsClass] of [['file-menu', 'file-toggle', 'file-actions'], ['canvas-menu', 'canvas-toggle', 'canvas-actions']]) {
    $(menuId).addEventListener('click', event => {
        if (event.target.closest(`.${actionsClass} button`)) $(menuId).open = false;
    });
    $(menuId).addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            $(menuId).open = false;
            $(toggleId).focus({ preventScroll: true });
        }
    });
}

const storeReady = openStore().then(value => { store = value; }).catch(error => {
    storageError = error;
    $('save-state').textContent = 'Browser saving unavailable';
    report(new Error('Browser storage is unavailable. Use Download project to keep your work. ' + error.message));
});

function snapshot() {
    return {
        cols: project.cols, rows: project.rows, layers: structuredClone(project.layers), activeLayerId: project.activeLayerId,
        selectedLayerIds: [...project.selectedLayerIds],
        width: project.width, height: project.height, referenceRect: project.referenceRect ?? null,
        reference: project.reference, referenceImage: reference,
    };
}

function prepareSampler() {
    sampleCanvas.width = Math.ceil(project.width);
    sampleCanvas.height = Math.ceil(project.height);
    // Sample the full-opacity reference, with transparency and blank board space displayed over white.
    sampleContext.fillStyle = '#ffffff';
    sampleContext.fillRect(0, 0, sampleCanvas.width, sampleCanvas.height);
    const rect = referenceRect(project);
    sampleContext.drawImage(reference, rect.x, rect.y);
}

function restoreSnapshot(saved) {
    placement.cancel(true);
    const { referenceImage, ...data } = saved;
    Object.assign(project, data);
    textPanelLayerId = null;
    textEditGeneration++;
    bindLayer(project);
    reference = referenceImage;
    prepareSampler();
    cursor = { x: 0, y: 0 };
}

function remember(before) {
    history.push(before);
    // Count each retained reference once, including images kept alive by crop undo.
    const cost = () => {
        const images = new Set();
        return history.reduce((sum, item) => {
            let size = item.layers.reduce((count, layer) => count + (layer.cells?.length || 0) + (layer.offCanvas?.length || 0) * 3 +
                (layer.text?.paths.reduce((sum, path) => sum + path.d.length / 4, 0) || 0), 0);
            if (!images.has(item.referenceImage)) {
                images.add(item.referenceImage);
                size += item.width * item.height + item.reference.length / 4;
            }
            return sum + size;
        }, 0);
    };
    while (history.length > 1 && cost() > 2000000) history.shift();
    future = [];
}

function changed() {
    dirty = true;
    revision++;
    $('save-state').textContent = 'Unsaved changes';
    clearTimeout(timer);
    timer = setTimeout(() => save().catch(report), 700);
    updateControls();
    layerPanel.render();
    if (yarnLine) refreshYarnMapping();
    if ($('yarn-menu').open) refreshYarnPanel();
}

async function save() {
    clearTimeout(timer);
    if (!project || !dirty) return;
    await storeReady;
    if (!store) throw new Error('Could not save in this browser. Download a project backup before leaving. ' + (storageError?.message || ''));
    const data = structuredClone(serializeLayers(project));
    const savedRevision = revision;
    data.updatedAt = Date.now();
    $('save-state').textContent = 'Saving on this device...';
    const operation = saveQueue.then(() => store.run('readwrite', objectStore => objectStore.put(data)));
    // Recover the queue for future saves; this operation's rejection is reported below.
    saveQueue = operation.catch(() => {});
    try {
        await operation;
    } catch (error) {
        $('save-state').textContent = 'Save failed - download a backup';
        throw new Error('Could not save your project (storage may be full or blocked). Download a backup. ' + error.message);
    }
    if (project?.id === data.id && revision === savedRevision) {
        dirty = false;
        project.updatedAt = data.updatedAt;
        $('save-state').textContent = 'Saved on this device';
    }
}

async function protectUnsaved() {
    finishPan();
    finishStroke();
    placement.commit();
    try {
        do {
            await save();
            finishStroke();
        } while (dirty);
        return true;
    } catch (error) {
        report(error);
        return confirm('Your current project could not be saved. Download project first to keep it. Continue and discard unsaved changes?');
    }
}

function toolPanel() {
    if (tool === 'text') return 'text';
    return ['paint', 'erase', 'line', 'shape', 'select', ...adjustmentTools].includes(tool) ? 'object' : null;
}

function activeStrokeKind() {
    if (placement.active) {
        if (placement.kind === 'line') return 'line';
        return placement.kind === 'shape' && !placement.filled ? 'shape' : null;
    }
    if (tool === 'shape') return $('shape-fill').value === 'filled' ? null : 'shape';
    return ['paint', 'erase', 'line', ...adjustmentTools].includes(tool) ? tool : null;
}

function setStrokeWidth(value) {
    const kind = activeStrokeKind();
    if (!kind) return;
    strokeWidths[kind] = value;
    try { localStorage.setItem(STROKE_KEY, JSON.stringify(strokeWidths)); } catch { /* Width still applies for this visit. */ }
    placement.setStroke(value);
    updateControls();
}

function updateControls() {
    const active = Boolean(project);
    $('workspace-controls').hidden = !active;
    // File actions all need an open project; the start screen offers projects and import instead.
    $('file-menu').hidden = $('canvas-menu').hidden = !active;
    if (!active) $('file-menu').open = $('canvas-menu').open = false;
    document.querySelectorAll('.canvas-actions button').forEach(button => { button.disabled = !active || Boolean(crop); });
    if (active) {
        for (const id of ['add-col-left', 'add-col-right', 'add-cols']) $(id).disabled ||= project.cols >= MAX_SIDE;
        for (const id of ['add-row-above', 'add-row-below', 'add-rows']) $(id).disabled ||= project.rows >= MAX_SIDE;
    }
    for (const id of ['name', 'backup', 'export', 'grid-toggle', 'crop-start', 'reference-toggle', 'lines-toggle', 'snapping-toggle']) $(id).disabled = !active || Boolean(crop);
    $('projects').disabled = Boolean(crop);
    document.querySelectorAll('[data-tool]').forEach(button => { button.disabled = !active || Boolean(crop); });
    $('undo').disabled = !active || Boolean(crop) || (!history.length && !placement.active);
    $('redo').disabled = !active || Boolean(crop) ||
        (placement.active && (!placement.layerSelected || placement.transformingLayer)) || !future.length;
    $('copy').disabled = !active || Boolean(crop) || !placement.selecting;
    $('cut').disabled = !active || Boolean(crop) || !placement.selecting;
    $('paste').disabled = !active || Boolean(crop) || !placement.canPaste;
    const textLayer = activeLayer(project)?.text ? activeLayer(project) : null;
    if (placement.active && !crop) settingsPanel = textLayer ? 'text' : 'object';
    else if (textLayer && !crop && !['grid', 'crop'].includes(settingsPanel)) settingsPanel = 'text';
    else if (!textLayer && settingsPanel === 'text' && tool !== 'text') settingsPanel = toolPanel();
    for (const panel of ['object', 'grid', 'crop', 'text']) $(`${panel}-settings`).hidden = !active || settingsPanel !== panel;
    $('text-new').disabled = !active || Boolean(crop) || creatingText;
    $('text-rasterize').disabled = !textLayer || textLayer.locks.all || Boolean(crop);
    for (const id of ['text-content', 'text-font', 'text-size', 'text-color']) $(id).disabled = !textLayer || textLayer.locks.all || Boolean(crop);
    if (textLayer) {
        const fresh = textPanelLayerId !== textLayer.id;
        for (const [id, value] of [['text-content', textLayer.text.content], ['text-font', textLayer.text.font],
            ['text-size', textLayer.text.size], ['text-color', textLayer.text.color]]) {
            if (fresh || document.activeElement !== $(id)) $(id).value = value;
        }
        textPanelLayerId = textLayer.id;
    } else textPanelLayerId = null;
    syncFontPicker();
    $('settings-dock').hidden = !active;
    const placeholder = $('tool-placeholder');
    placeholder.hidden = Boolean(settingsPanel);
    if (!settingsPanel) {
        placeholder.replaceChildren();
        const button = document.querySelector(`[data-tool="${tool}"]`);
        const icon = button?.querySelector('svg');
        if (icon) placeholder.append(icon.cloneNode(true));
        placeholder.append(button ? `${button.getAttribute('aria-label')} tool` : 'No tool selected');
    }
    $('grid-toggle').setAttribute('aria-expanded', String(active && settingsPanel === 'grid'));
    $('crop-start').setAttribute('aria-expanded', String(active && settingsPanel === 'crop'));
    $('shape-options').hidden = tool !== 'shape' || (placement.active && placement.kind !== 'shape');
    $('object-transform').hidden = placement.active ? !placement.layerSelected && !['shape', 'paste'].includes(placement.kind) : tool !== 'shape';
    $('placement-apply').disabled = !placement.active || (placement.selecting && !placement.layerSelected);
    $('placement-cancel').disabled = !placement.active;
    for (const key of ['width', 'height', 'angle']) $(`object-${key}`).disabled = !placement.active;
    const strokeKind = activeStrokeKind();
    $('stroke-options').hidden = !strokeKind;
    $('placement-actions').hidden = $('object-help').hidden = (['paint', 'erase'].includes(tool) || adjustmentTools.includes(tool)) && !placement.active;
    const adjusting = adjustmentTools.includes(tool) && !placement.active;
    $('adjustment-options').hidden = !adjusting;
    if (adjusting) {
        const settings = adjustmentSettings[tool];
        $('adjustment-intensity').value = $('adjustment-range').value = settings.intensity;
        $('tone-options').hidden = tool === 'sponge';
        $('sponge-options').hidden = tool !== 'sponge';
        if (tool === 'sponge') $('sponge-mode').value = settings.mode;
        else $('tone-range').value = settings.range;
    }
    if (strokeKind) {
        $('stroke-label').textContent = { line: 'Line width', shape: 'Outline width' }[strokeKind] || 'Brush size';
        $('stroke-width').value = $('stroke-range').value = strokeWidths[strokeKind];
    }
    $('save-now').disabled = !active;
    $('zoom-out').disabled = !active || zoom <= MIN_ZOOM;
    $('zoom-in').disabled = !active || zoom >= MAX_ZOOM;
    if (active) {
        const rect = referenceRect(project);
            $('dimensions').textContent = `${project.cols} x ${project.rows} cells${project.blank ? ' | Blank canvas' : ` | Reference ${rect.width} x ${rect.height}px`}`;
        $('grid-size').value = Math.max(project.cols, project.rows);
        $('grid-number').value = $('grid-size').value;
    }
    renderBrushPreview();
}

function renderBrushPreview() {
    const overlay = $('brush-preview'), outline = $('brush-outline');
    overlay.hidden = true;
    if (!brushPointer || !project || !largeScreen.matches || crop || pan || spaceHeld || placement.active ||
        !['paint', 'erase', ...adjustmentTools].includes(tool) || document.querySelector('dialog[open]')) return;
    const rect = canvas.getBoundingClientRect();
    const { clientX, clientY } = brushPointer;
    if (!rect.width || !rect.height || clientX < rect.left || clientX >= rect.right ||
        clientY < rect.top || clientY >= rect.bottom || !inWorkspaceViewport(brushPointer)) return;
    const cell = cellAt(brushPointer);
    const bounds = brushBounds(cell.x, cell.y, strokeWidths[tool]);
    const left = Math.max(0, bounds.x), top = Math.max(0, bounds.y);
    const right = Math.min(project.cols, bounds.x + bounds.width), bottom = Math.min(project.rows, bounds.y + bounds.height);
    Object.assign(outline.style, {
        left: `${left / project.cols * 100}%`, top: `${top / project.rows * 100}%`,
        width: `${(right - left) / project.cols * 100}%`, height: `${(bottom - top) / project.rows * 100}%`,
    });
    overlay.hidden = false;
}

function renderPalette() {
    const focusedColor = $('palette').contains(document.activeElement) ? document.activeElement.title : null;
    $('palette').replaceChildren();
    const colors = project ? project.palette : [];
    for (const color of colors) {
        const button = document.createElement('button');
        button.className = 'swatch';
        button.style.backgroundColor = color;
        const yarn = yarnLine ? displayColor(color) : null;
        // While previewing, the lower-right half shows the yarn this color will render as.
        if (yarn) button.style.backgroundImage = `linear-gradient(135deg, ${color} 50%, ${yarn} 50%)`;
        button.setAttribute('aria-label', yarn ? `Paint with ${color}, previewed as yarn ${yarn}` : `Paint with ${color}`);
        button.title = color;
        button.setAttribute('aria-pressed', String(color === selected));
        button.addEventListener('click', () => {
            finishStroke();
            selected = color;
            renderPalette();
            placement.refresh();
        });
        $('palette').append(button);
    }
    $('selected-color').textContent = selected ? `Selected: ${selected}` : 'Add a color or sample your reference to start.';
    $('palette-current').style.background = selected || '';
    $('palette-current-label').textContent = selected ? `Selected color ${selected}` : 'No color selected';
    $('palette-toggle').title = selected ? `Palette - ${selected}` : 'Palette - no color selected';
    if (focusedColor) {
        Array.from($('palette').children).find(button => button.title === focusedColor)?.focus({ preventScroll: true });
    }
    $('add-color').disabled = !project || Boolean(crop);
    $('new-color').disabled = !project || Boolean(crop);
    $('delete-color').disabled = !project || Boolean(crop) || !selected;
    if (yarnLine && project && yarnPaletteKey !== project.palette.join()) {
        refreshYarnMapping();
        renderPalette();
    }
}

$('palette-menu').addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('palette-menu').open) {
        event.preventDefault();
        event.stopPropagation();
        $('palette-menu').open = false;
        $('palette-toggle').focus({ preventScroll: true });
    }
});
document.addEventListener('pointerdown', event => {
    for (const id of ['palette-menu', 'file-menu', 'canvas-menu', 'yarn-menu']) {
        const menu = $(id);
        if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
}, true);

// Yarn preview: a view-only recoloring of the pattern in one yarn line. Project colors never change.
let yarnLines = null, yarnLoading = null, yarnLine = null, yarnMatch = null, yarnMap = new Map(), yarnPaletteKey = '';

function displayColor(color) {
    if (!yarnLine) return color;
    let yarn = yarnMap.get(color);
    if (yarn === undefined) {
        // Colors outside the current match (e.g. painted since it was computed) use their nearest yarn.
        try { yarn = yarnLine.custom ? closestYarn(color, yarnLines).yarn : findClosestColor(color, yarnLine.colors); } catch { yarn = color; }
        yarnMap.set(color, yarn);
    }
    return yarn;
}

function refreshYarnMapping() {
    if (!yarnLine || !project) return;
    const previous = yarnMap;
    const usage = colorUsage(flattenLayers(project), project.palette);
    yarnMatch = yarnLine.custom ? matchCustomMix(usage, yarnLines) : matchYarnLine(usage, yarnLine);
    yarnMap = new Map();
    for (const [color, match] of yarnMatch.mapping) yarnMap.set(color, match.yarn);
    // The match is keyed by lowercase hex; also key the project's own spelling for fast lookups.
    for (const color of [...project.palette, ...previous.keys()]) {
        if (!yarnMap.has(color) && yarnMap.has(color.toLowerCase())) yarnMap.set(color, yarnMap.get(color.toLowerCase()));
    }
    yarnPaletteKey = project.palette.join();
    // Adding a color can reassign other colors' yarns, so repaint whenever anything moved.
    if (previous.size !== yarnMap.size || [...yarnMap].some(([color, yarn]) => previous.get(color) !== yarn)) {
        paintedTiles = null;
        render();
    }
    renderYarnMapping();
}

function loadYarnLines() {
    yarnLoading ||= fetch('./yarn-palettes.json')
        .then(response => {
            if (!response.ok) throw new Error(`The yarn catalog could not be loaded (${response.status}).`);
            return response.json();
        })
        .then(data => {
            yarnLines = prepareYarnLines(data).sort((a, b) => a.name.localeCompare(b.name));
            const group = document.createElement('optgroup');
            group.label = `All yarn lines (${yarnLines.length})`;
            group.append(...yarnLines.map(line => new Option(`${line.name} (${line.colors.length})`, line.name)));
            $('yarn-line').append(group);
            return yarnLines;
        })
        .catch(error => { yarnLoading = null; throw error; });
    return yarnLoading;
}

function setYarnLine(name) {
    yarnLine = name === CUSTOM_MIX ? { name: CUSTOM_MIX, custom: true }
        : name ? yarnLines.find(line => line.name === name) || null : null;
    yarnMap = new Map();
    yarnMatch = null;
    yarnPaletteKey = '';
    $('yarn-line').value = yarnLine ? yarnLine.name : '';
    $('yarn-current').textContent = yarnLine ? yarnLine.name : 'Original colors';
    $('yarn-toggle').title = yarnLine ? `Previewing yarn line ${yarnLine.name}` : 'Yarn match - showing original colors';
    $('yarn-menu').toggleAttribute('data-previewing', Boolean(yarnLine));
    $('export-yarn-label').hidden = !yarnLine;
    $('export-yarn-name').textContent = yarnLine ? yarnLine.name : '';
    if (!yarnLine) $('export-yarn').checked = false;
    document.querySelectorAll('.yarn-option').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.line === name)));
    if (yarnLine) refreshYarnMapping();
    else {
        renderYarnMapping();
        paintedTiles = null;
        render();
    }
    renderPalette();
}

function swatchChip(color) {
    const chip = document.createElement('span');
    chip.className = 'yarn-chip';
    chip.style.background = color;
    return chip;
}

function renderYarnMapping() {
    const list = $('yarn-mapping');
    list.replaceChildren();
    $('yarn-mapping-section').hidden = !yarnLine || !yarnMatch || !yarnMatch.mapping.size;
    if ($('yarn-mapping-section').hidden) return;
    renderYarnColors(list, colorUsage(flattenLayers(project), project.palette), yarnMatch);
}

function renderYarnColors(list, usage, matchResult = null, showCounts = false) {
    list.replaceChildren();
    const counts = new Map(usage.map(item => [item.color, item.count]));
    const rows = matchResult ? [...matchResult.mapping] : usage.map(item => [item.color, null]);
    rows.sort((a, b) => (counts.get(b[0]) || 0) - (counts.get(a[0]) || 0));
    for (const [color, match] of rows) {
        const item = document.createElement('li');
        item.append(swatchChip(color));
        if (!match) {
            const label = document.createElement('span');
            label.className = 'yarn-source';
            label.textContent = color;
            item.append(label);
        } else {
            const arrow = document.createElement('span');
            arrow.textContent = '\u2192';
            const yarn = document.createElement('span');
            yarn.className = 'yarn-source';
            yarn.textContent = match.line ? `${match.line} \u00b7 ${match.yarn}` : match.yarn;
            const score = document.createElement('span');
            score.className = 'yarn-match-score';
            if (match.score < USABLE_SCORE) score.classList.add('weak');
            score.textContent = match.shared && !match.line ? 'no free yarn' : `${Math.round(match.score)}`;
            score.title = match.shared && !match.line
                ? 'This line has fewer yarns than your pattern has distinct colors, so this color reuses its nearest yarn.'
                : `Match score ${Math.round(match.score)} of 100`;
            item.title = `${color} \u2192 ${match.line ? `${match.line} ` : ''}${match.yarn}`;
            item.append(arrow, swatchChip(match.yarn), yarn, score);
        }
        if (showCounts) {
            const count = document.createElement('span');
            count.className = 'yarn-stitches';
            count.textContent = `${(counts.get(color) || 0).toLocaleString()} stitches`;
            item.append(count);
        }
        list.append(item);
    }
}

function yarnOption(result, rankLabel, detailText, onSelect = name => setYarnLine(yarnLine?.name === name ? '' : name), activeName = yarnLine?.name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'yarn-option';
    button.dataset.line = result.name;
    button.setAttribute('aria-pressed', String(activeName === result.name));
    const rank = document.createElement('span');
    rank.className = 'yarn-rank';
    rank.textContent = rankLabel;
    const name = document.createElement('span');
    name.className = 'yarn-name';
    name.textContent = result.name;
    const score = document.createElement('span');
    score.className = 'yarn-score';
    score.textContent = Math.round(result.score);
    score.title = 'Overall match score out of 100';
    const detail = document.createElement('span');
    detail.className = 'yarn-detail';
    detail.textContent = detailText;
    const strip = document.createElement('span');
    strip.className = 'yarn-strip';
    strip.setAttribute('aria-hidden', 'true');
    for (const match of result.mapping.values()) {
        const part = document.createElement('span');
        part.style.background = match.yarn;
        strip.append(part);
    }
    button.append(rank, name, score, detail, strip);
    button.addEventListener('click', () => onSelect(result.name));
    return button;
}

function renderYarnRanking(ranking, custom, colorCount) {
    const list = $('yarn-ranking');
    list.replaceChildren();
    $('yarn-status').textContent = !colorCount
        ? 'Add or paint colors to get yarn recommendations.'
        : `Best of ${yarnLines.length} lines for your ${colorCount} color${colorCount === 1 ? '' : 's'}. Scores weigh how close each color is and how much of the pattern uses it.`;
    $('yarn-custom-section').hidden = !custom.total;
    $('yarn-custom').replaceChildren();
    if (custom.total) {
        $('yarn-custom').append(yarnOption(custom, 'Mix',
            `${custom.usable} of ${custom.total} colors usable \u00b7 ${custom.size} yarn${custom.size === 1 ? '' : 's'} from ${custom.lines} line${custom.lines === 1 ? '' : 's'}`));
    }
    ranking.forEach((result, index) => {
        const item = document.createElement('li');
        item.append(yarnOption(result, index === 0 ? 'Best' : `#${index + 1}`,
            `${result.usable} of ${result.total} colors usable \u00b7 ${result.size} yarns in line`));
        list.append(item);
    });
    // Mirror the recommendations in the selector so keyboard users can reach them first.
    $('yarn-line').querySelector('optgroup[data-recommended]')?.remove();
    if (ranking.length) {
        const group = document.createElement('optgroup');
        group.label = 'Recommended';
        group.dataset.recommended = '';
        group.append(new Option(`${CUSTOM_MIX} (any brand) - ${Math.round(custom.score)}`, CUSTOM_MIX),
            ...ranking.map((result, index) => new Option(`${index + 1}. ${result.name} - ${Math.round(result.score)}`, result.name)));
        $('yarn-line').options[0].after(group);
        $('yarn-line').value = yarnLine ? yarnLine.name : '';
    }
}

async function refreshYarnPanel() {
    if (!project) return;
    $('yarn-status').textContent = yarnLines ? 'Scoring yarn lines...' : 'Loading the yarn catalog...';
    try {
        await loadYarnLines();
    } catch (error) {
        $('yarn-status').textContent = error.message;
        return;
    }
    // Let the status paint before the ranking work.
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
    if (!project || !$('yarn-menu').open) return;
    const usage = colorUsage(flattenLayers(project), project.palette);
    renderYarnRanking(rankYarnLines(usage, yarnLines, 5), matchCustomMix(usage, yarnLines), usage.length);
    if (yarnLine) refreshYarnMapping();
}

$('yarn-menu').addEventListener('toggle', () => {
    if ($('yarn-menu').open) refreshYarnPanel();
});
$('yarn-menu').addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('yarn-menu').open) {
        event.preventDefault();
        event.stopPropagation();
        $('yarn-menu').open = false;
        $('yarn-toggle').focus({ preventScroll: true });
    }
});
$('yarn-line').addEventListener('change', () => setYarnLine($('yarn-line').value));

// Sizes the canvas element and workspace for the current zoom without touching the bitmap.
function layoutCanvas() {
    const wrap = $('canvas-wrap');
    const workspace = $('workspace');
    const layout = canvasLayout(project, workspace.clientWidth, workspace.clientHeight, rulerPadding(), zoom, !crop);
    if (!layout) return null;
    const { width, height, padX, padY, wrapWidth, wrapHeight } = layout;
    wrap.style.padding = `${padY}px ${padX}px`;
    wrap.style.width = `${wrapWidth}px`;
    wrap.style.height = `${wrapHeight}px`;
    // Keep the display bitmap bounded on large monitors; CSS zoom and hit testing remain exact.
    const dpr = Math.min(devicePixelRatio || 1, 2, 8192 / Math.max(width, height));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    renderBrushPreview();
    return { bitmapWidth: Math.round(width * dpr), bitmapHeight: Math.round(height * dpr) };
}

function centerCanvas() {
    const workspace = $('workspace');
    workspace.scrollTo((workspace.scrollWidth - workspace.clientWidth) / 2,
        (workspace.scrollHeight - workspace.clientHeight) / 2);
}

function render({ paint = true } = {}) {
    $('sample-preview').hidden = true;
    clearTimeout(zoomSettleTimer);
    zoomSettleTimer = 0;
    if (!project || !largeScreen.matches) { drawRulers(); return; }
    const size = layoutCanvas();
    if (!size) return;
    const { bitmapWidth, bitmapHeight } = size;
    // Reassigning canvas dimensions reallocates the bitmap, so only do it when the size changes.
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
        canvas.width = bitmapWidth;
        canvas.height = bitmapHeight;
    }
    paintedGridVisible = gridVisible();
    paintedTiles = null;
    if (paint) paintVisibleTiles();
    drawnPreview = previewBounds();
    drawnCursor = cursorVisible();
    renderCrop();
    placement.render();
    drawRulers();
}

// Row and column numbers framing the grid, in knitting-chart order: columns count right to left and
// rows bottom to top, with odd rows labelled on the right and even rows on the left. Each band hugs
// the grid and sticks to the edge of the viewport once the grid extends past it, and the label size
// follows the on-screen cell size so it scales with zoom.
const rulers = $('rulers');
const rulerContext = rulers.getContext('2d');
const RULER_FONT_MIN = 8, RULER_FONT_MAX = 13, RULER_GAP = 6;
const RULER_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500];
const rulerFont = size => `600 ${size}px system-ui, sans-serif`;

function rulerSideWidth(size) {
    rulerContext.font = rulerFont(size);
    return Math.ceil(rulerContext.measureText(String(project.rows)).width) + RULER_GAP * 2;
}

// Room around the grid for the largest bands, so scrolling to an edge never leaves labels over cells.
function rulerPadding() {
    return { x: Math.max(24, rulerSideWidth(RULER_FONT_MAX) + 2), y: Math.max(24, RULER_FONT_MAX + RULER_GAP + 2) };
}

function drawRulers() {
    const workspace = $('workspace');
    const show = Boolean(project) && !crop && largeScreen.matches && !$('canvas-wrap').hidden && canvas.width > 0;
    rulers.hidden = !show;
    if (!show) return;
    const area = rulers.offsetParent || rulers.parentElement;
    const view = workspace.getBoundingClientRect(), areaRect = area.getBoundingClientRect();
    const left = view.left + workspace.clientLeft, top = view.top + workspace.clientTop;
    const width = workspace.clientWidth, height = workspace.clientHeight;
    rulers.style.left = `${left - areaRect.left - area.clientLeft}px`;
    rulers.style.top = `${top - areaRect.top - area.clientTop}px`;
    rulers.style.width = `${width}px`;
    rulers.style.height = `${height}px`;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (rulers.width !== Math.round(width * dpr) || rulers.height !== Math.round(height * dpr)) {
        rulers.width = Math.round(width * dpr);
        rulers.height = Math.round(height * dpr);
    }
    const ctx = rulerContext;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const grid = canvas.getBoundingClientRect();
    const gx = grid.left - left, gy = grid.top - top, gw = grid.width, gh = grid.height;
    if (!gw || !gh) return;
    const cellW = gw / project.cols, cellH = gh / project.rows;
    const size = Math.round(Math.max(RULER_FONT_MIN, Math.min(RULER_FONT_MAX, 6 + Math.min(cellW, cellH) * 0.25)));
    const bandH = size + RULER_GAP, bandW = rulerSideWidth(size);
    ctx.font = rulerFont(size);
    const topY = Math.max(0, gy - bandH), bottomY = Math.min(height - bandH, gy + gh);
    const leftX = Math.max(0, gx - bandW), rightX = Math.min(width - bandW, gx + gw);
    // Visible part of the grid; nothing to frame when it is scrolled fully out of view.
    const x0 = Math.max(0, gx), x1 = Math.min(width, gx + gw), y0 = Math.max(0, gy), y1 = Math.min(height, gy + gh);
    if (x1 <= x0 || y1 <= y0) return;

    ctx.fillStyle = 'rgba(8, 16, 10, 0.9)';
    ctx.fillRect(leftX, topY, rightX + bandW - leftX, bandH);
    ctx.fillRect(leftX, bottomY, rightX + bandW - leftX, bandH);
    ctx.fillRect(leftX, topY, bandW, bottomY + bandH - topY);
    ctx.fillRect(rightX, topY, bandW, bottomY + bandH - topY);
    ctx.strokeStyle = 'rgba(241, 218, 168, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(leftX + bandW - 0.5, topY + bandH - 0.5, rightX - leftX - bandW + 1, bottomY - topY - bandH + 1);
    ctx.fillStyle = '#f1daa8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Columns: label every column when they fit, otherwise every Nth with N a round number.
    const colNeed = ctx.measureText(String(project.cols)).width + 4;
    const colStep = RULER_STEPS.find(step => step * cellW >= colNeed) ?? RULER_STEPS.at(-1);
    const clipL = leftX + bandW, clipR = rightX;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipL, 0, Math.max(0, clipR - clipL), height);
    ctx.clip();
    const firstCol = Math.max(0, Math.floor((clipL - gx) / cellW)), lastCol = Math.min(project.cols - 1, Math.ceil((clipR - gx) / cellW));
    for (let c = firstCol; c <= lastCol; c++) {
        const number = project.cols - c;
        if (number % colStep) continue;
        const x = gx + (c + 0.5) * cellW;
        ctx.fillText(String(number), x, topY + bandH / 2 + 0.5);
        ctx.fillText(String(number), x, bottomY + bandH / 2 + 0.5);
    }
    ctx.restore();

    // Rows: alternate sides (odd right, even left) while two rows fit a label, else every Nth on both.
    const rowNeed = size + 2;
    const alternate = cellH * 2 >= rowNeed;
    const rowStep = alternate ? 1 : RULER_STEPS.find(step => step * cellH >= rowNeed) ?? RULER_STEPS.at(-1);
    const clipT = topY + bandH, clipB = bottomY;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, clipT, width, Math.max(0, clipB - clipT));
    ctx.clip();
    const firstRow = Math.max(0, Math.floor((clipT - gy) / cellH)), lastRow = Math.min(project.rows - 1, Math.ceil((clipB - gy) / cellH));
    for (let r = firstRow; r <= lastRow; r++) {
        const number = project.rows - r;
        if (number % rowStep) continue;
        const y = gy + (r + 0.5) * cellH + 0.5;
        if (!alternate || number % 2 === 0) ctx.fillText(String(number), leftX + bandW / 2, y);
        if (!alternate || number % 2 === 1) ctx.fillText(String(number), rightX + bandW / 2, y);
    }
    ctx.restore();
}

// Only the tiles near the viewport are painted on a full render; the rest are painted as they
// scroll into view, so zooming costs the same at 800% as at 100%.
const TILE = 32;
let paintedTiles = null, zoomSettleTimer = 0;

function paintVisibleTiles() {
    if (!project || !canvas.width) return;
    const across = Math.ceil(project.cols / TILE), down = Math.ceil(project.rows / TILE);
    if (!paintedTiles || paintedTiles.length !== across * down) paintedTiles = new Uint8Array(across * down);
    const workspace = $('workspace'), rect = canvas.getBoundingClientRect(), view = workspace.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const toCol = x => Math.floor((x - rect.left) / rect.width * project.cols / TILE);
    const toRow = y => Math.floor((y - rect.top) / rect.height * project.rows / TILE);
    const tx0 = Math.max(0, toCol(view.left) - 1), tx1 = Math.min(across - 1, toCol(view.left + workspace.clientWidth) + 1);
    const ty0 = Math.max(0, toRow(view.top) - 1), ty1 = Math.min(down - 1, toRow(view.top + workspace.clientHeight) + 1);
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        if (paintedTiles[ty * across + tx]) continue;
        minX = Math.min(minX, tx); maxX = Math.max(maxX, tx);
        minY = Math.min(minY, ty); maxY = Math.max(maxY, ty);
    }
    if (maxX < 0) return;
    for (let ty = minY; ty <= maxY; ty++) paintedTiles.fill(1, ty * across + minX, ty * across + maxX + 1);
    renderCells(minX * TILE, minY * TILE, (maxX + 1) * TILE - 1, (maxY + 1) * TILE - 1);
}

const cellLayer = document.createElement('canvas');
// CPU-backed: it is rewritten with putImageData on every edit, which avoids GPU upload/readback churn.
const cellLayerContext = cellLayer.getContext('2d', { willReadFrequently: true });
let cellImage = null, cellWords = null;
const colorWords = new Map();
const colorProbe = document.createElement('canvas').getContext('2d');

// Converts a CSS color to a little-endian RGBA word for the cell layer's pixel buffer.
function colorWord(color) {
    let word = colorWords.get(color);
    if (word !== undefined) return word;
    let hex = /^#[0-9a-f]{6}$/i.test(color) ? color : null;
    if (!hex) {
        colorProbe.fillStyle = '#000000';
        colorProbe.fillStyle = color;
        hex = /^#[0-9a-f]{6}$/i.test(colorProbe.fillStyle) ? colorProbe.fillStyle : '#000000';
    }
    const value = parseInt(hex.slice(1), 16);
    word = (0xff000000 | (value & 0xff) << 16 | (value & 0xff00) | (value >> 16 & 0xff)) >>> 0;
    colorWords.set(color, word);
    return word;
}

function updateCellLayer(x0, y0, x1, y1, withPreview) {
    if (cellLayer.width !== project.cols || cellLayer.height !== project.rows || !cellImage) {
        cellLayer.width = project.cols;
        cellLayer.height = project.rows;
        cellImage = cellLayerContext.createImageData(project.cols, project.rows);
        cellWords = new Uint32Array(cellImage.data.buffer);
    }
    const cols = project.cols, recolor = Boolean(yarnLine);
    const ordered = layerOrder(project).filter(layer => layer.type === 'layer' && layerVisible(project, layer));
    const preview = withPreview ? placement.preview() : null;
    const replacing = withPreview && placement.transformingLayer;
    const composite = createLayerCompositor(project, preview, replacing, ordered);
    const converted = new WeakMap();
    for (let y = y0; y < y1; y++) {
        for (let index = y * cols + x0, end = y * cols + x1; index < end; index++) {
            const pixel = composite(index);
            if (!pixel) { cellWords[index] = 0; continue; }
            let word = converted.get(pixel);
            if (word === undefined) {
                word = recolor ? colorWord(displayColor(pixelColor(pixel, true))) : pixelWord(pixel);
                converted.set(pixel, word);
            }
            cellWords[index] = word;
        }
    }
    cellLayerContext.putImageData(cellImage, 0, 0, x0, y0, x1 - x0, y1 - y0);
}

// Cell bounds (inclusive) of the floating line/shape/paste preview, or null when none.
function previewBounds() {
    if (!project || crop || tool === 'sample') return null;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (const index of placement.preview().keys()) {
        const x = index % project.cols, y = (index - x) / project.cols;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY };
}
let drawnPreview = null, drawnCursor = false, drawnLayerSelection = false;

function cursorVisible() {
    return Boolean(project) && !crop && !placement.active && tool !== 'move' && keyboardFocus;
}

// Placement edits only change the cells under the old and new previews, so repaint just those boxes.
function renderPlacement() {
    if (!project || !largeScreen.matches || !canvas.width) return render();
    const layerWasSelected = drawnLayerSelection;
    drawnLayerSelection = placement.layerSelected;
    if (placement.layerSelected || layerWasSelected) return render();
    const next = previewBounds();
    for (const box of [drawnPreview, next]) if (box) renderCells(box.minX, box.minY, box.maxX, box.maxY);
    drawnPreview = next;
    if (drawnCursor !== cursorVisible()) renderCells(cursor.x, cursor.y, cursor.x, cursor.y);
    drawnCursor = cursorVisible();
    placement.render();
}

function gridVisible() {
    return Boolean(project) && showGrid(project.cols, project.rows, canvas.clientWidth, canvas.clientHeight, canvas.width, canvas.height);
}

function paintLayers(x0, y0, x1, y1) {
    const cellWidth = project.width / project.cols, cellHeight = project.height / project.rows;
    context.setTransform(canvas.width / project.width, 0, 0, canvas.height / project.height, 0, 0);
    const showReference = crop || tool === 'sample' || $('reference-toggle').checked;
    if (showReference) context.fillStyle = '#ffffff';
    else {
        transparencyPattern.setTransform(new DOMMatrix().scale(project.width / canvas.clientWidth, project.height / canvas.clientHeight));
        context.fillStyle = transparencyPattern;
    }
    context.fillRect(x0 * cellWidth, y0 * cellHeight, (x1 - x0) * cellWidth, (y1 - y0) * cellHeight);
    if (showReference) {
        context.globalAlpha = crop || tool === 'sample' ? 1 : 0.6;
        // Drawing only the needed part of the reference keeps tile repaints proportional to their size.
        const rect = referenceRect(project);
        const left = Math.max(x0 * cellWidth, rect.x), top = Math.max(y0 * cellHeight, rect.y);
        const right = Math.min(x1 * cellWidth, rect.x + rect.width), bottom = Math.min(y1 * cellHeight, rect.y + rect.height);
        if (right > left && bottom > top) {
            context.drawImage(reference, left - rect.x, top - rect.y, right - left, bottom - top, left, top, right - left, bottom - top);
        }
        context.globalAlpha = 1;
    }
    if (crop || tool !== 'sample') {
        // Cells live in a 1-pixel-per-cell layer that is scaled up in one draw call.
        updateCellLayer(x0, y0, x1, y1, !crop);
        context.imageSmoothingEnabled = false;
        context.drawImage(cellLayer, x0, y0, x1 - x0, y1 - y0,
            x0 * cellWidth, y0 * cellHeight, (x1 - x0) * cellWidth, (y1 - y0) * cellHeight);
        context.imageSmoothingEnabled = true;
    }
    if (!crop && tool !== 'sample' && $('lines-toggle').checked && gridVisible()) {
        context.strokeStyle = 'rgba(30, 45, 35, 0.3)';
        context.lineWidth = project.width / canvas.width;
        context.beginPath();
        for (let x = x0; x <= x1; x++) {
            context.moveTo(x * cellWidth, y0 * cellHeight);
            context.lineTo(x * cellWidth, y1 * cellHeight);
        }
        for (let y = y0; y <= y1; y++) {
            context.moveTo(x0 * cellWidth, y * cellHeight);
            context.lineTo(x1 * cellWidth, y * cellHeight);
        }
        context.stroke();
    }
    if (cursorVisible()) {
        context.strokeStyle = '#ffffff';
        context.lineWidth = 3 * project.width / canvas.width;
        context.strokeRect(cursor.x * cellWidth, cursor.y * cellHeight, cellWidth, cellHeight);
        context.strokeStyle = '#202020';
        context.lineWidth = project.width / canvas.width;
        context.strokeRect(cursor.x * cellWidth, cursor.y * cellHeight, cellWidth, cellHeight);
    }
}

// Repaints only the cells in the inclusive range, clipped to whole device pixels so the
// result matches a full render without redrawing all cells on every pointer move.
function renderCells(minX, minY, maxX, maxY) {
    if (!project || !canvas.width || !canvas.height) return render();
    const scaleX = canvas.width / project.cols, scaleY = canvas.height / project.rows;
    const left = Math.max(0, Math.floor(Math.max(0, minX) * scaleX) - 1);
    const top = Math.max(0, Math.floor(Math.max(0, minY) * scaleY) - 1);
    const right = Math.min(canvas.width, Math.ceil((Math.min(project.cols - 1, maxX) + 1) * scaleX) + 1);
    const bottom = Math.min(canvas.height, Math.ceil((Math.min(project.rows - 1, maxY) + 1) * scaleY) + 1);
    if (right <= left || bottom <= top) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.beginPath();
    context.rect(left, top, right - left, bottom - top);
    context.clip();
    // One extra cell on every side covers antialiased edges and gridlines that touch the clip.
    paintLayers(
        Math.max(0, Math.floor(left / scaleX) - 1), Math.max(0, Math.floor(top / scaleY) - 1),
        Math.min(project.cols, Math.ceil(right / scaleX) + 1), Math.min(project.rows, Math.ceil(bottom / scaleY) + 1),
    );
    context.restore();
}

async function decodeImage(src) {
    const image = new Image();
    // Waits for the load event rather than decode(), which stalls while the tab is in the background.
    await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('The source image cannot be decoded.'));
        image.src = src;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image has no usable dimensions.');
    return image;
}

async function activate(data) {
    validateProject(data);
    const image = await decodeImage(data.reference);
    const rect = referenceRect(data);
    if (image.naturalWidth !== rect.width || image.naturalHeight !== rect.height) throw new Error('The project reference dimensions are invalid.');
    if (!(await protectUnsaved())) return false;
    project = migrateLayers(data);
    reference = image;
    prepareSampler();
    selected = data.palette[0] || null;
    tool = 'paint';
    settingsPanel = toolPanel();
    canvas.classList.remove('sampling');
    $('workspace').classList.remove('moving');
    document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
    history = [];
    future = [];
    cursor = { x: 0, y: 0 };
    zoom = 1;
    dirty = false;
    revision++;
    $('name').value = project.name;
    $('empty').hidden = true;
    $('canvas-wrap').hidden = false;
    $('workspace').classList.add('editing');
    $('workspace').scrollTo(0, 0);
    $('save-state').textContent = 'Saved on this device';
    $('project-dialog').close();
    $('yarn-ranking').replaceChildren();
    $('yarn-custom').replaceChildren();
    $('yarn-custom-section').hidden = true;
    $('yarn-line').querySelector('optgroup[data-recommended]')?.remove();
    $('yarn-menu').open = false;
    if (yarnLine) setYarnLine('');
    updateControls();
    clearGridError();
    renderPalette();
    layerPanel.render();
    render();
    centerCanvas();
    return true;
}

function imageReference(image) {
    const size = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * size));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * size));
    const thumbnail = document.createElement('canvas');
    thumbnail.width = width;
    thumbnail.height = height;
    thumbnail.getContext('2d').drawImage(image, 0, 0, width, height);
    return thumbnail;
}

async function newFromImage(image, name) {
    const thumbnail = imageReference(image), { width, height } = thumbnail;
    const { cols, rows } = gridDimensions(width, height, 50);
    const activated = await activate({
        version: 1, id: crypto.randomUUID(), name: name.slice(0, 80) || 'Untitled pattern',
        width, height, cols, rows, reference: thumbnail.toDataURL('image/png'),
        palette: [], cells: Array(cols * rows).fill(null), updatedAt: Date.now(),
    });
    if (!activated) return;
    changed();
    notify('Your reference is ready. Add a color or use Color sampler, then choose Paint. The reference is never included in exports.');
    return true;
}

function addPaletteColor(color) {
    const existing = project.palette.find(item => item.toLowerCase() === color);
    if (!existing) {
        if (project.palette.length >= 32) throw new Error('The demo supports up to 32 palette colors per project.');
        project.palette.push(color);
        changed();
    }
    selected = existing || color;
    $('new-color').value = selected;
    renderPalette();
    placement.refresh();
}

function sampleColor(x, y) {
    const pixel = sampleContext.getImageData(
        Math.max(0, Math.min(sampleCanvas.width - 1, Math.floor(x))),
        Math.max(0, Math.min(sampleCanvas.height - 1, Math.floor(y))), 1, 1).data;
    return '#' + Array.from(pixel.slice(0, 3), value => value.toString(16).padStart(2, '0')).join('');
}

function previewSample(event) {
    const rect = canvas.getBoundingClientRect();
    const color = sampleColor((event.clientX - rect.left) / rect.width * project.width,
        (event.clientY - rect.top) / rect.height * project.height);
    $('sample-swatch').style.backgroundColor = color;
    $('sample-hex').textContent = color;
    const preview = $('sample-preview');
    preview.hidden = false;
    preview.style.left = `${Math.max(0, Math.min(event.clientX + 20, innerWidth - preview.offsetWidth - 8))}px`;
    preview.style.top = `${Math.max(0, Math.min(event.clientY + 20, innerHeight - preview.offsetHeight - 8))}px`;
    return color;
}

function needsPaintColor() {
    if (tool === 'select') return false;
    const layer = activeLayer(project);
    if (layer?.text) {
        notify('This is an editable text layer. Use Tool options to change its text, or rasterize it before painting.', true);
        return true;
    }
    if (!layer || layer.type !== 'layer' || layer.locks.all || (layer.locks.color && layer.locks.transparency)) {
        notify(layer?.type === 'folder' ? 'Select a pixel layer to paint.' : 'This layer is locked for pixel editing.', true);
        return true;
    }
    if (!layerVisible(project, layer)) {
        notify('Show this layer and its folder before editing.', true);
        return true;
    }
    if (['paint', 'fill', 'line', 'shape'].includes(tool) && !selected) {
        notify('Add a palette color or use Color sampler before painting.', true);
        return true;
    }
    return false;
}

function cellAt(event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: Math.max(0, Math.min(project.cols - 1, Math.floor((event.clientX - rect.left) / rect.width * project.cols))),
        y: Math.max(0, Math.min(project.rows - 1, Math.floor((event.clientY - rect.top) / rect.height * project.rows))),
    };
}

function applyCell(x, y) {
    const layer = activeLayer(project);
    if (layer?.type !== 'layer') return false;
    const color = tool === 'erase' ? null : selected;
    let blocked = false;
    const write = (index, value) => {
        const differs = layer.cells[index] !== value;
        const painted = writeLayerCell(layer, index, value);
        if (differs && !painted) blocked = true;
        return painted;
    };
    const finish = painted => {
        if (blocked && !painted) notify('This edit is blocked by the layer locks.', true);
        return painted;
    };
    if (adjustmentTools.includes(tool)) {
        const result = adjustBrush(project, layer, x, y, strokeWidths[tool],
            { tool, ...adjustmentSettings[tool] }, stroke?.visited);
        blocked = result.blocked;
        return finish(result.changed);
    }
    if (tool === 'fill') {
        const cells = layer.cells.slice();
        if (!flood(cells, project.cols, project.rows, x, y, color)) return false;
        let painted = false;
        for (let i = 0; i < cells.length; i++) if (cells[i] !== layer.cells[i]) painted = write(i, cells[i]) || painted;
        return finish(painted);
    }
    if (tool === 'paint' || tool === 'erase') {
        let painted = false;
        brush(x, y, strokeWidths[tool], (bx, by) => {
            if (bx < 0 || by < 0 || bx >= project.cols || by >= project.rows) return;
            const index = by * project.cols + bx;
            if (write(index, color)) painted = true;
        });
        return finish(painted);
    }
    const index = y * project.cols + x;
    return finish(write(index, color));
}

function renderStroke(from, to) {
    const reach = ['paint', 'erase', ...adjustmentTools].includes(tool) ? strokeWidth(strokeWidths[tool]) : 1;
    renderCells(
        Math.min(from.x, to.x) - reach, Math.min(from.y, to.y) - reach,
        Math.max(from.x, to.x) + reach, Math.max(from.y, to.y) + reach,
    );
}

function finishStroke() {
    if (!stroke) return;
    const finished = stroke;
    stroke = null;
    if (canvas.hasPointerCapture(finished.id)) canvas.releasePointerCapture(finished.id);
    if (finished.changed) {
        remember(finished.before);
        changed();
    }
}

canvas.addEventListener('pointerdown', event => {
    if (!project || crop || tool === 'move' || !largeScreen.matches || event.button !== 0 || stroke || !event.isPrimary) return;
    event.preventDefault();
    pointerFocus = true;
    canvas.focus({ preventScroll: true });
    pointerFocus = false;
    keyboardFocus = false;
    if (placement.active) {
        placement.begin(event, tool);
        return;
    }
    if (tool === 'text') {
        const layer = activeLayer(project);
        if (layer?.text) placement.selectLayers();
        else notify('Add a text layer using New text layer in Tool options.', true);
        return;
    }
    if (tool === 'sample') {
        try {
            render();
            const color = previewSample(event);
            addPaletteColor(color);
            notify(`Selected ${color}. Choose Paint to use it, or sample another color.`);
        } catch (error) { report(error); }
        return;
    }
    if (needsPaintColor()) return;
    if (placement.begin(event, tool)) return;
    const position = cellAt(event), previousCursor = cursor;
    cursor = position;
    stroke = { id: event.pointerId, before: snapshot(), last: position, changed: false, visited: new Set() };
    canvas.setPointerCapture(event.pointerId);
    stroke.changed = applyCell(position.x, position.y);
    if (tool === 'fill') return render();
    if (stroke.changed) renderStroke(position, position);
    if (drawnCursor) {
        renderCells(previousCursor.x, previousCursor.y, previousCursor.x, previousCursor.y);
        drawnCursor = false;
    }
});
canvas.addEventListener('pointermove', event => {
    if (project && !crop && largeScreen.matches && tool === 'sample') {
        if (!spaceHeld && !pan) previewSample(event);
        return;
    }
    if (!stroke || stroke.id !== event.pointerId || tool === 'fill') return;
    const position = cellAt(event);
    let painted = false;
    line(stroke.last.x, stroke.last.y, position.x, position.y, (x, y) => {
        if (applyCell(x, y)) painted = true;
    });
    if (painted) {
        stroke.changed = true;
        renderStroke(stroke.last, position);
    }
    stroke.last = position;
});
for (const name of ['pointerenter', 'pointermove', 'pointerdown']) canvas.addEventListener(name, event => {
    if (!event.isPrimary) return;
    brushPointer = { clientX: event.clientX, clientY: event.clientY };
    renderBrushPreview();
});
canvas.addEventListener('pointerleave', () => {
    $('sample-preview').hidden = true;
    brushPointer = null;
    renderBrushPreview();
});
$('workspace').addEventListener('scroll', () => {
    $('sample-preview').hidden = true;
    paintVisibleTiles();
    drawRulers();
    renderBrushPreview();
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, finishStroke);
canvas.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') $('sample-preview').hidden = true;
    if (event.pointerType === 'touch') { brushPointer = null; renderBrushPreview(); }
});
canvas.addEventListener('pointercancel', () => {
    $('sample-preview').hidden = true;
    brushPointer = null;
    renderBrushPreview();
});
window.addEventListener('blur', () => { brushPointer = null; renderBrushPreview(); });
canvas.addEventListener('focus', () => {
    if (pointerFocus) return;
    keyboardFocus = true;
    renderPlacement();
});
canvas.addEventListener('blur', () => {
    if (!keyboardFocus) return;
    keyboardFocus = false;
    renderPlacement();
});

function finishPan() {
    if (!pan) return;
    const id = pan.id;
    pan = null;
    const workspace = $('workspace');
    workspace.classList.remove('panning');
    if (workspace.hasPointerCapture(id)) workspace.releasePointerCapture(id);
}

// True when the pointer is inside the workspace's visible area, excluding its scrollbars.
function inWorkspaceViewport(event) {
    const workspace = $('workspace');
    const rect = workspace.getBoundingClientRect();
    const left = rect.left + workspace.clientLeft, top = rect.top + workspace.clientTop;
    return event.clientX >= left && event.clientX < left + workspace.clientWidth &&
        event.clientY >= top && event.clientY < top + workspace.clientHeight;
}

function startPan(event) {
    const workspace = $('workspace');
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: workspace.scrollLeft, top: workspace.scrollTop };
    workspace.setPointerCapture(event.pointerId);
    workspace.classList.add('panning');
    renderBrushPreview();
}

$('workspace').addEventListener('pointerdown', event => {
    if (!project || crop || tool !== 'move' || !largeScreen.matches || pan || event.button !== 0 || !event.isPrimary) return;
    if (!inWorkspaceViewport(event)) return;
    event.preventDefault();
    pointerFocus = true;
    canvas.focus({ preventScroll: true });
    pointerFocus = false;
    keyboardFocus = false;
    startPan(event);
});

// Holding Space pans with any tool, like Move. Capturing here keeps the press away from the canvas,
// placement handles, and click-away, so it never paints or finalizes a line, shape, or paste.
function setSpaceHeld(value) {
    spaceHeld = value;
    $('workspace').classList.toggle('space-pan', value);
    if (value) $('sample-preview').hidden = true;
    renderBrushPreview();
}
$('workspace').addEventListener('pointerenter', () => { pointerOverWorkspace = true; });
$('workspace').addEventListener('pointerleave', () => { pointerOverWorkspace = false; });
$('workspace').addEventListener('pointerdown', event => {
    if (!spaceHeld || !project || crop || !largeScreen.matches || pan || stroke || event.button !== 0 || !event.isPrimary) return;
    if (!inWorkspaceViewport(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    startPan(event);
}, true);
document.addEventListener('keydown', event => {
    if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (spaceHeld) {
        // Swallow auto-repeat so a held Space never activates a focused button or paints.
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    if (!project || crop || !largeScreen.matches || document.querySelector('dialog[open]')) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"], .sidebar-panel > summary'))) return;
    const inWorkspace = target instanceof Element && Boolean(target.closest('#workspace'));
    if (!pointerOverWorkspace && !inWorkspace) return;
    // Keyboard-cursor users keep Space for painting or sampling the focused cell.
    if (keyboardFocus && target === canvas) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setSpaceHeld(true);
}, true);
document.addEventListener('keyup', event => {
    if (event.key !== ' ' || !spaceHeld) return;
    event.preventDefault();
    setSpaceHeld(false);
}, true);
window.addEventListener('blur', () => setSpaceHeld(false));
$('workspace').addEventListener('pointermove', event => {
    if (!pan || event.pointerId !== pan.id) return;
    event.preventDefault();
    $('workspace').scrollTo(pan.left + pan.x - event.clientX, pan.top + pan.y - event.clientY);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('workspace').addEventListener(name, event => {
    if (pan && event.pointerId === pan.id) finishPan();
});
window.addEventListener('blur', finishPan);

canvas.addEventListener('keydown', event => {
    if (!project || crop || !largeScreen.matches) return;
    if (placement.keydown(event)) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (tool === 'move') {
        if (moves[event.key]) {
            event.preventDefault();
            finishPan();
            const step = event.shiftKey ? 120 : 40;
            $('workspace').scrollBy(moves[event.key][0] * step, moves[event.key][1] * step);
        } else if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
        }
        return;
    }
    if (moves[event.key]) {
        event.preventDefault();
        finishStroke();
        if (tool === 'text') {
            if (activeLayer(project)?.text) placement.selectLayers();
            return;
        }
        cursor.x = Math.max(0, Math.min(project.cols - 1, cursor.x + moves[event.key][0]));
        cursor.y = Math.max(0, Math.min(project.rows - 1, cursor.y + moves[event.key][1]));
        keyboardFocus = true;
        render();
    } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        finishStroke();
        if (tool === 'sample') {
            try {
                const color = sampleColor((cursor.x + 0.5) * project.width / project.cols,
                    (cursor.y + 0.5) * project.height / project.rows);
                addPaletteColor(color);
                notify(`Selected ${color}. Choose Paint to use it, or sample another color.`);
            } catch (error) { report(error); }
            return;
        }
        if (needsPaintColor()) return;
        if (['line', 'shape', 'select'].includes(tool)) {
            placement.startKeyboard(tool, cursor);
            return;
        }
        const before = snapshot();
        if (applyCell(cursor.x, cursor.y)) { remember(before); changed(); render(); }
    }
});

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
    finishPan();
    finishStroke();
    placement.commit();
    tool = button.dataset.tool;
    if (tool === 'text') {
        settingsPanel = 'text';
        ensureTextFonts().catch(report);
        if (activeLayer(project)?.text) placement.selectLayers();
        else createTextLayer().catch(report);
    }
    settingsPanel = toolPanel();
    canvas.classList.toggle('sampling', tool === 'sample');
    $('workspace').classList.toggle('moving', tool === 'move');
    $('sample-preview').hidden = true;
    document.querySelectorAll('[data-tool]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    updateControls();
    render();
    if (tool === 'sample') notify('Hover over the reference to preview a color. Click or tap to add it to your palette. Choose Paint when ready.');
    if (tool === 'move') notify('Drag the canvas to move around the zoomed view without painting. Arrow keys also pan; Shift moves farther. With any tool, hold Space and drag to pan. Choose Paint to resume drawing.');
    if (adjustmentTools.includes(tool)) notify('Brush over painted pixels on the active layer. Each pixel is adjusted once per stroke; release and brush again to build the effect. No palette color is needed.');
    if (['line', 'shape', 'select'].includes(tool)) notify(tool === 'select'
        ? 'Drag a selection on the grid, then Copy or Cut and Paste.'
        : 'Drag to draw. Adjust handles and palette color, then click away or Apply to finalize.');
}));

async function ensureTextFonts() {
    const entries = await fontCatalog();
    if (!$('text-font').options.length) {
        $('text-font').replaceChildren(...entries.map(entry => new Option(entry.name, entry.file)));
        for (const entry of entries) {
            const button = document.createElement('button');
            button.type = 'button';
            button.role = 'option';
            button.tabIndex = -1;
            button.dataset.font = entry.file;
            button.textContent = entry.name;
            button.setAttribute('aria-label', entry.name);
            button.addEventListener('click', () => {
                $('text-font').value = entry.file;
                closeFontPicker();
                syncFontPicker();
                $('text-font').dispatchEvent(new Event('change'));
                $('text-font-toggle').focus({ preventScroll: true });
            });
            $('text-font-options').append(button);
            loadSvgFont(entry.file).then(font => {
                button.replaceChildren(fontNamePreview(font, entry));
                syncFontPicker();
            }).catch(error => report(new Error(`Font preview unavailable for ${entry.name}: ${error.message}`)));
        }
        syncFontPicker();
    }
    return entries;
}

function closeFontPicker() {
    $('text-font-options').hidden = true;
    $('text-font-toggle').setAttribute('aria-expanded', 'false');
}

function syncFontPicker() {
    const select = $('text-font'), toggle = $('text-font-toggle');
    toggle.disabled = select.disabled;
    const options = [...$('text-font-options').children];
    for (const option of options) option.setAttribute('aria-selected', String(option.dataset.font === select.value));
    const selected = options.find(option => option.dataset.font === select.value);
    if (selected) {
        const current = $('text-font-current');
        current.replaceChildren(...[...selected.childNodes].map(node => node.cloneNode(true)));
        current.setAttribute('aria-label', selected.getAttribute('aria-label'));
    }
    if (toggle.disabled || $('text-settings').hidden) closeFontPicker();
}

$('text-font-toggle').addEventListener('click', () => {
    const open = $('text-font-options').hidden;
    $('text-font-options').hidden = !open;
    $('text-font-toggle').setAttribute('aria-expanded', String(open));
    if (open) $('text-font-options').querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
});
$('text-font-picker').addEventListener('keydown', event => {
    const options = [...$('text-font-options').children];
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeFontPicker();
        $('text-font-toggle').focus({ preventScroll: true });
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && options.length) {
        event.preventDefault();
        $('text-font-options').hidden = false;
        $('text-font-toggle').setAttribute('aria-expanded', 'true');
        const index = options.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
            (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next].focus({ preventScroll: true });
    }
});
document.addEventListener('click', event => {
    if (!$('text-font-picker').contains(event.target)) closeFontPicker();
});
$('text-font-picker').addEventListener('focusout', event => {
    if (!$('text-font-picker').contains(event.relatedTarget)) closeFontPicker();
});

async function createTextLayer() {
    if (!project || crop || creatingText) return;
    if (placement.commit() === false) return;
    const owner = project;
    creatingText = true;
    updateControls();
    try {
        const entries = await ensureTextFonts(), file = entries[0].file;
        const font = await loadSvgFont(file);
        if (project !== owner || crop) throw new Error('The project changed while loading the text font. Try adding text again.');
        layerRoom(project, true);
        const { text } = layoutText(font, { content: 'Text', font: file, size: Math.min(24, Math.max(4, Math.floor(project.rows / 3))),
            color: selected || '#000000', matrix: [1, 0, 0, 1, Math.floor(project.cols / 4), Math.floor(project.rows / 4)] });
        const layer = newLayer(project.cols, project.rows, 'Text');
        Object.assign(layer, { text }, layerRaster(project, rasterText(text)));
        checkLayerMemory(project, [...project.layers, layer]);
        const current = activeLayer(project);
        layer.parentId = current?.type === 'folder' ? current.id : current?.parentId || null;
        const parent = project.layers.find(item => item.id === layer.parentId);
        const before = snapshot();
        if (parent) parent.expanded = true;
        project.layers.splice(Math.max(0, project.layers.indexOf(current)), 0, layer);
        project.activeLayerId = layer.id;
        project.selectedLayerIds = [layer.id];
        bindLayer(project);
        remember(before);
        settingsPanel = 'text';
        changed();
        placement.selectLayers();
        render();
        $('tools-dock').open = true;
        $('text-content').focus();
        $('text-content').select();
        notify('Text layer created. Type in Tool options; drag its box to move, its corners to scale, or outside a corner to rotate.');
    } finally { creatingText = false; updateControls(); }
}

async function editTextLayer() {
    const owner = project, layer = activeLayer(project);
    if (!layer?.text) return;
    const generation = ++textEditGeneration;
    const values = { content: $('text-content').value, font: $('text-font').value,
        size: Number($('text-size').value), color: $('text-color').value };
    const checkEditing = () => {
        if (layer.locks.all || layer.locks.color || layer.locks.transparency) throw new Error('Unlock text pixel locks before changing text, font, size, or color.');
        if (!layerVisible(project, layer)) throw new Error('Show this text layer and its folders before editing.');
        if (layer.locks.position && (values.size !== layer.text.size || values.font !== layer.text.font)) throw new Error('Unlock the text layer position before changing font or size.');
    };
    try {
        checkEditing();
        if (!$('text-size').value.trim()) throw new Error('Font size must be a whole number from 1 to 500 cells.');
        const font = await loadSvgFont(values.font);
        if (generation !== textEditGeneration || project !== owner || activeLayer(project) !== layer || crop) return;
        checkEditing();
        if (placement.commit() === false) return;
        const { text, missing } = layoutText(font, { ...values, matrix: layer.text.matrix });
        const raster = layerRaster(project, rasterText(text));
        if (JSON.stringify(text) === JSON.stringify(layer.text)) return;
        checkLayerMemory(project, project.layers.map(item => item === layer ? { ...item, ...raster } : item));
        remember(snapshot());
        Object.assign(layer, { text }, raster);
        bindLayer(project);
        changed();
        placement.selectLayers();
        render();
        if (missing.length) notify(`Font has no glyph for: ${missing.join(' ')}. Missing-character boxes are shown.`, true);
    } catch (error) {
        report(error);
        textPanelLayerId = null;
        updateControls();
    }
}

$('text-new').addEventListener('click', () => createTextLayer().catch(report));
for (const id of ['text-content', 'text-color']) $(id).addEventListener('input', editTextLayer);
for (const id of ['text-font', 'text-size']) $(id).addEventListener('change', editTextLayer);
$('text-size').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.target.dispatchEvent(new Event('change')); }
});
$('text-rasterize').addEventListener('click', () => {
    const layer = activeLayer(project);
    if (!layer?.text) return;
    if (layer.locks.all) { notify('Unlock this text layer before rasterizing it.', true); return; }
    if (placement.commit() === false) return;
    remember(snapshot());
    delete layer.text;
    settingsPanel = toolPanel();
    changed();
    placement.selectLayers();
    notify('Text rasterized to editable pixels. Undo restores the editable text.');
});
ensureTextFonts().then(updateControls).catch(report);

for (const id of ['adjustment-intensity', 'adjustment-range']) $(id).addEventListener(id === 'adjustment-range' ? 'input' : 'change', event => {
    if (!adjustmentTools.includes(tool)) return;
    const value = Number(event.target.value);
    if (!event.target.value.trim() || !Number.isInteger(value) || value < 0 || value > 100) {
        notify('Intensity must be a whole number from 0 to 100.', true);
        event.target.value = adjustmentSettings[tool].intensity;
        return;
    }
    finishStroke();
    adjustmentSettings[tool].intensity = value;
    updateControls();
});
$('adjustment-intensity').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.target.dispatchEvent(new Event('change')); }
});
for (const [id, key] of [['tone-range', 'range'], ['sponge-mode', 'mode']]) $(id).addEventListener('change', event => {
    if (!adjustmentTools.includes(tool)) return;
    finishStroke();
    adjustmentSettings[tool][key] = event.target.value;
});

function undo() {
    if (crop) return;
    if (placement.active) {
        const selectedLayer = placement.layerSelected && !placement.transformingLayer;
        placement.cancel();
        if (!selectedLayer) return;
    }
    finishStroke();
    if (!history.length) return;
    future.push(snapshot());
    restoreSnapshot(history.pop());
    changed(); render();
}

function redo() {
    if (crop) return;
    if (placement.active) {
        if (!placement.layerSelected || placement.transformingLayer) return;
        placement.cancel(true);
    }
    finishStroke();
    if (!future.length) return;
    history.push(snapshot());
    restoreSnapshot(future.pop());
    changed(); render();
}

action('undo', undo);
action('redo', redo);
action('copy', () => placement.copy());
action('cut', () => placement.cut());
action('paste', () => placement.paste());
// Click-away finalizes a placement only inside the pixel-grid viewport. The canvas itself is handled by
// placement.begin; scrollbars and controls outside the viewport leave it editable.
$('workspace').addEventListener('pointerdown', event => {
    if (!placement.active || spaceHeld || pan || event.button !== 0 || !event.isPrimary ||
        event.target.closest('#canvas-stage') || !inWorkspaceViewport(event)) return;
    placement.commit();
}, true);
document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || !project || crop || !largeScreen.matches ||
        document.querySelector('dialog[open]')) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) {
        if (event.key === 'Escape' && target.closest('#object-settings')) placement.keydown(event);
        return;
    }
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey || event.shiftKey) && (key === '[' || key === ']')) {
        const kind = activeStrokeKind();
        if (!kind || spaceHeld || pan) return;
        event.preventDefault();
        finishStroke();
        setStrokeWidth(Math.max(1, Math.min(MAX_STROKE, strokeWidths[kind] + (key === ']' ? 1 : -1))));
        return;
    }
    if (target instanceof Element && target.closest('.sidebar-panel > summary')) return;
    if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v'].includes(key)) {
        event.preventDefault();
        finishStroke();
        if (key === 'c') placement.copy();
        else if (key === 'x') placement.cut();
        else placement.paste();
    } else if (!(event.ctrlKey || event.metaKey)) placement.keydown(event);
});
function setZoom(value, anchor) {
    if (!project) return;
    finishPan();
    finishStroke();
    const workspace = $('workspace');
    const previous = canvas.getBoundingClientRect();
    const viewport = workspace.getBoundingClientRect();
    const anchorX = anchor ? anchor.x : viewport.left + workspace.clientWidth / 2;
    const anchorY = anchor ? anchor.y : viewport.top + workspace.clientHeight / 2;
    const centerX = (anchorX - previous.left) / previous.width;
    const centerY = (anchorY - previous.top) / previous.height;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    updateControls();
    // Resize the element now and let the browser stretch the existing bitmap; reallocating and
    // repainting it at full resolution costs far more, so that waits until zooming pauses.
    const size = largeScreen.matches ? layoutCanvas() : null;
    // A bitmap much larger than needed makes newly revealed tiles expensive, so shrink it right away.
    const full = !size || canvas.width > size.bitmapWidth * 1.5 || paintedGridVisible !== gridVisible();
    // Paint after the scroll is re-anchored so only the tiles that end up visible are drawn.
    if (full) render({ paint: false });
    const next = canvas.getBoundingClientRect();
    workspace.scrollLeft += next.left + centerX * next.width - anchorX;
    workspace.scrollTop += next.top + centerY * next.height - anchorY;
    paintVisibleTiles();
    drawRulers();
    if (full) return;
    clearTimeout(zoomSettleTimer);
    zoomSettleTimer = setTimeout(render, ZOOM_SETTLE_MS);
}
const ZOOM_SETTLE_MS = 150;
action('zoom-in', () => setZoom(stepZoom(zoom, 1)));
action('zoom-out', () => setZoom(stepZoom(zoom, -1)));
document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) ||
        !project || !largeScreen.matches || document.querySelector('dialog[open]')) return;
    const step = ['+', '='].includes(event.key) ? 1 : ['-', '_'].includes(event.key) ? -1 : 0;
    if (!step) return;
    // Zoom the pattern instead of the browser page; at the limits the shortcut is still consumed.
    event.preventDefault();
    const button = $(step > 0 ? 'zoom-in' : 'zoom-out');
    if (!button.disabled) setZoom(stepZoom(zoom, step));
});
let wheelZoomDelta = 0;
$('workspace').addEventListener('wheel', event => {
    if (!(event.ctrlKey || event.metaKey) || !project || crop || !largeScreen.matches) return;
    event.preventDefault();
    // Trackpad pinches send many small ctrl+wheel deltas; accumulate them into 25% steps.
    const scale = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1;
    wheelZoomDelta += event.deltaY * scale;
    if (Math.abs(wheelZoomDelta) < 50) return;
    const step = wheelZoomDelta < 0 ? 1 : -1;
    wheelZoomDelta = 0;
    const next = stepZoom(zoom, step);
    if (next !== zoom) setZoom(next, { x: event.clientX, y: event.clientY });
}, { passive: false });
document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.altKey ||
        !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' ||
        !project || crop || !largeScreen.matches || document.querySelector('dialog[open]')) return;
    const target = event.target;
    if (target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) return;
    event.preventDefault();
    try {
        if (event.shiftKey) redo();
        else undo();
    } catch (error) { report(error); }
});
action('grid-toggle', () => {
    settingsPanel = settingsPanel === 'grid' ? null : 'grid';
    updateControls();
});
function clearGridError() {
    $('grid-error').textContent = '';
    $('grid-number').removeAttribute('aria-invalid');
}

function showGridError(error, restore = false) {
    $('grid-error').textContent = error.message + (restore ? ' The previous grid size has been restored.' : '');
    $('grid-number').setAttribute('aria-invalid', 'true');
    if (restore) {
        $('grid-number').value = Math.max(project.cols, project.rows);
        $('grid-size').value = $('grid-number').value;
    }
}

$('grid-size').addEventListener('input', () => {
    $('grid-number').value = $('grid-size').value;
    clearGridError();
});
$('grid-number').addEventListener('input', () => {
    try {
        const size = parseGridSize($('grid-number').value);
        $('grid-size').value = size;
        clearGridError();
    } catch (error) { showGridError(error); }
});
$('grid-number').addEventListener('change', () => {
    try { $('grid-number').value = parseGridSize($('grid-number').value); }
    catch (error) { showGridError(error); }
});
function applyGrid() {
    if (!project || crop) return;
    let size;
    try { size = parseGridSize($('grid-number').value); }
    catch (error) { showGridError(error, true); return; }
    clearGridError();
    $('grid-number').value = size;
    $('grid-size').value = size;
    const { cols, rows } = gridDimensions(project.width, project.height, size);
    if (cols === project.cols && rows === project.rows) return;
    placement.commit();
    const before = snapshot();
    const oldCols = project.cols, oldRows = project.rows;
    transformLayers(project, cells => resizeCells(cells, oldCols, oldRows, cols, rows), cols, rows,
        (x, y) => [Math.floor((x + 0.5) * cols / oldCols), Math.floor((y + 0.5) * rows / oldRows)],
        [cols / oldCols, 0, 0, rows / oldRows, 0, 0]);
    remember(before);
    cursor = { x: 0, y: 0 };
    changed(); render();
    notify('Grid resized. Existing paint was resampled; Undo restores the previous grid.');
}
action('apply-grid', applyGrid);
$('grid-number').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        finishStroke();
        applyGrid();
    }
});

// Canvas edits change the grid and its board together. Adding cells only grows the board and
// leaves the reference untouched; mirror and rotate transform the reference's own pixels.
function transformReference(width, height, draw) {
    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    draw(output.getContext('2d'));
    return output;
}

function applyCanvasEdit(changes, output, message, transform, mapPoint) {
    const before = snapshot();
    const cols = changes.cols ?? project.cols, rows = changes.rows ?? project.rows;
    transformLayers(project, transform, cols, rows, mapPoint);
    remember(before);
    delete changes.cells;
    Object.assign(project, changes);
    if (output) {
        project.reference = output.toDataURL('image/png');
        reference = output;
    }
    prepareSampler();
    cursor = { x: 0, y: 0 };
    changed(); render();
    notify(message);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function addCells(sides) {
    if (!project || crop) return;
    const { left = 0, right = 0, top = 0, bottom = 0 } = sides;
    const grown = extendCells(project.cells, project.cols, project.rows, sides);
    if (Math.max(grown.cols, grown.rows) > MAX_SIDE) throw new Error(`Patterns are limited to ${MAX_SIDE} cells per side.`);
    const added = left || right ? plural(left + right, 'column') : plural(top + bottom, 'row');
    const where = left ? 'to the left' : right ? 'to the right' : top ? 'above' : 'below';
    applyCanvasEdit({ ...grown, ...extendBoard(project, sides) }, null,
        `Added ${added} ${where}. Undo removes ${left + right + top + bottom === 1 ? 'it' : 'them'}.`,
        cells => extendCells(cells, project.cols, project.rows, sides).cells, (x, y) => [x + left, y + top]);
}

function mirrorCanvas(axis) {
    if (!project || crop) return;
    const { width, height } = referenceRect(project);
    const output = transformReference(width, height, ctx => {
        if (axis === 'horizontal') ctx.setTransform(-1, 0, 0, 1, width, 0);
        else ctx.setTransform(1, 0, 0, -1, 0, height);
        ctx.drawImage(reference, 0, 0);
    });
    applyCanvasEdit({ cells: mirrorCells(project.cells, project.cols, project.rows, axis), ...mirrorBoard(project, axis) }, output,
        `Mirrored ${axis === 'horizontal' ? 'left to right' : 'top to bottom'}.`,
        cells => mirrorCells(cells, project.cols, project.rows, axis),
        (x, y) => axis === 'horizontal' ? [project.cols - 1 - x, y] : [x, project.rows - 1 - y]);
}

function rotateCanvas(clockwise) {
    if (!project || crop) return;
    const { width, height } = referenceRect(project);
    const output = transformReference(height, width, ctx => {
        if (clockwise) ctx.setTransform(0, 1, -1, 0, height, 0);
        else ctx.setTransform(0, -1, 1, 0, 0, width);
        ctx.drawImage(reference, 0, 0);
    });
    applyCanvasEdit({ ...rotateCells(project.cells, project.cols, project.rows, clockwise), ...rotateBoard(project, clockwise) }, output,
        `Rotated 90\u00b0 ${clockwise ? 'right' : 'left'}.`,
        cells => rotateCells(cells, project.cols, project.rows, clockwise).cells,
        (x, y) => clockwise ? [project.rows - 1 - y, x] : [y, project.cols - 1 - x]);
}

action('add-col-left', () => addCells({ left: 1 }));
action('add-col-right', () => addCells({ right: 1 }));
action('add-row-above', () => addCells({ top: 1 }));
action('add-row-below', () => addCells({ bottom: 1 }));
action('mirror-horizontal', () => mirrorCanvas('horizontal'));
action('mirror-vertical', () => mirrorCanvas('vertical'));
action('rotate-right', () => rotateCanvas(true));
action('rotate-left', () => rotateCanvas(false));

let extendAxis = 'columns';
function extendRoom() {
    return MAX_SIDE - (extendAxis === 'columns' ? project.cols : project.rows);
}
function openExtend(axis) {
    if (!project || crop) return;
    extendAxis = axis;
    const columns = axis === 'columns', room = extendRoom();
    $('extend-title').textContent = $('extend-apply').textContent = columns ? 'Add columns' : 'Add rows';
    $('extend-side').replaceChildren(...(columns ? [['left', 'Left side'], ['right', 'Right side']] : [['top', 'Top'], ['bottom', 'Bottom']])
        .map(([value, label]) => new Option(label, value)));
    $('extend-count').max = room;
    $('extend-count').value = Math.min(1, room);
    $('extend-limit').textContent = `This pattern has ${plural(columns ? project.cols : project.rows, columns ? 'column' : 'row')}. ` +
        `Up to ${room} more fit within the ${MAX_SIDE}-cell limit.`;
    $('extend-dialog').querySelector('.dialog-message').textContent = '';
    $('extend-dialog').showModal();
    $('extend-count').select();
}
action('add-cols', () => openExtend('columns'));
action('add-rows', () => openExtend('rows'));
function applyExtend() {
    const input = $('extend-count'), count = Number(input.value), room = extendRoom();
    if (!input.value.trim() || !Number.isInteger(count) || count < 1 || count > room) {
        $('extend-dialog').querySelector('.dialog-message').textContent = `Enter a whole number from 1 to ${room}.`;
        input.focus();
        return;
    }
    $('extend-dialog').close();
    addCells({ [$('extend-side').value]: count });
}
action('extend-apply', applyExtend);
$('extend-count').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); $('extend-apply').click(); }
});
$('extend-count').addEventListener('input', () => { $('extend-dialog').querySelector('.dialog-message').textContent = ''; });

// Crop works in whole reference pixels; a padded board may have a fractional edge.
function cropBounds() {
    return { width: Math.max(1, Math.floor(project.width + 1e-6)), height: Math.max(1, Math.floor(project.height + 1e-6)) };
}

function renderCrop() {
    $('crop-overlay').hidden = !crop;
    if (!crop) return;
    const { rect, ratioKey } = crop;
    const frame = $('crop-frame');
    frame.style.left = `${rect.x / project.width * 100}%`;
    frame.style.top = `${rect.y / project.height * 100}%`;
    frame.style.width = `${rect.width / project.width * 100}%`;
    frame.style.height = `${rect.height / project.height * 100}%`;
    frame.setAttribute('aria-label', `Crop frame: ${rect.width} by ${rect.height} pixels, at ${rect.x}, ${rect.y}`);
    $('crop-width').value = rect.width;
    $('crop-height').value = rect.height;
    $('crop-width').disabled = ratioKey !== 'free';
    $('crop-height').disabled = ratioKey !== 'free';
    $('crop-width').max = cropBounds().width - rect.x;
    $('crop-height').max = cropBounds().height - rect.y;
    $('crop-scale-label').hidden = ratioKey === 'free';
    if (ratioKey !== 'free') {
        const full = fitCrop(cropBounds().width, cropBounds().height, CROP_RATIOS[ratioKey]);
        const percent = Math.max(1, Math.round(rect.width / full.width * 100));
        $('crop-scale').value = percent;
        $('crop-scale-value').value = `${percent}%`;
    }
}

function endCropDrag() {
    if (!cropDrag) return;
    const id = cropDrag.id;
    cropDrag = null;
    if ($('crop-overlay').hasPointerCapture(id)) $('crop-overlay').releasePointerCapture(id);
}

function exitCrop(applied = false) {
    if (!crop) return;
    endCropDrag();
    const previous = crop.previousView;
    crop = null;
    settingsPanel = toolPanel();
    zoom = applied ? 1 : previous.zoom;
    updateControls();
    renderPalette();
    render();
    if (applied) centerCanvas();
    else $('workspace').scrollTo(previous.x, previous.y);
    canvas.focus({ preventScroll: true });
}

action('crop-start', () => {
    if (!project || crop) return;
    const workspace = $('workspace');
    crop = {
        rect: fitCrop(cropBounds().width, cropBounds().height, null), ratioKey: 'free',
        previousView: { zoom, x: workspace.scrollLeft, y: workspace.scrollTop },
    };
    zoom = 1;
    $('crop-ratio').value = 'free';
    $('crop-error').textContent = '';
    settingsPanel = 'crop';
    updateControls();
    renderPalette();
    render();
    workspace.scrollTo(0, 0);
    $('crop-frame').focus({ preventScroll: true });
    notify('Adjust the crop frame, then Apply crop. Shaded areas will be removed. Cancel keeps the original.');
});
action('crop-cancel', () => { exitCrop(); notify('Crop cancelled. Your pattern is unchanged.'); });

$('crop-ratio').addEventListener('change', () => {
    if (!crop) return;
    try {
        const key = $('crop-ratio').value;
        const rect = key === 'free' ? crop.rect : fitCrop(cropBounds().width, cropBounds().height, CROP_RATIOS[key]);
        crop.rect = rect;
        crop.ratioKey = key;
        $('crop-error').textContent = '';
    } catch (error) {
        $('crop-error').textContent = error.message;
        $('crop-ratio').value = crop.ratioKey;
    }
    renderCrop();
});
$('crop-scale').addEventListener('input', () => {
    if (!crop || crop.ratioKey === 'free') return;
    const old = crop.rect;
    const next = fitCrop(cropBounds().width, cropBounds().height, CROP_RATIOS[crop.ratioKey], Number($('crop-scale').value) / 100);
    crop.rect = moveCrop(next, old.x + old.width / 2 - next.x - next.width / 2,
        old.y + old.height / 2 - next.y - next.height / 2, cropBounds().width, cropBounds().height);
    renderCrop();
});
for (const dimension of ['width', 'height']) {
    $(`crop-${dimension}`).addEventListener('change', event => {
        if (!crop || crop.ratioKey !== 'free') return;
        const value = Math.floor(Number(event.target.value));
        const limit = dimension === 'width' ? cropBounds().width - crop.rect.x : cropBounds().height - crop.rect.y;
        if (!Number.isFinite(value) || value < 1 || value > limit) {
            $('crop-error').textContent = `Crop ${dimension} must be from 1 to ${limit} pixels.`;
        } else {
            crop.rect[dimension] = value;
            $('crop-error').textContent = '';
        }
        renderCrop();
    });
}

$('crop-overlay').addEventListener('pointerdown', event => {
    if (!crop || cropDrag || event.button !== 0 || !event.isPrimary || !event.target.closest('#crop-frame')) return;
    event.preventDefault();
    const corner = event.target.closest('[data-corner]');
    (corner || $('crop-frame')).focus({ preventScroll: true });
    cropDrag = {
        id: event.pointerId, x: event.clientX, y: event.clientY, rect: { ...crop.rect },
        bounds: canvas.getBoundingClientRect(), corner: corner?.dataset.corner,
    };
    $('crop-overlay').setPointerCapture(event.pointerId);
});
$('crop-overlay').addEventListener('pointermove', event => {
    if (!crop || !cropDrag || event.pointerId !== cropDrag.id) return;
    const dx = (event.clientX - cropDrag.x) * project.width / cropDrag.bounds.width;
    const dy = (event.clientY - cropDrag.y) * project.height / cropDrag.bounds.height;
    crop.rect = cropDrag.corner
        ? resizeCrop(cropDrag.rect, cropDrag.corner, dx, dy, cropBounds().width, cropBounds().height, CROP_RATIOS[crop.ratioKey])
        : moveCrop(cropDrag.rect, dx, dy, cropBounds().width, cropBounds().height);
    renderCrop();
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('crop-overlay').addEventListener(name, endCropDrag);
$('crop-frame').addEventListener('keydown', event => {
    if (!crop) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!moves[event.key]) return;
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    let [dx, dy] = moves[event.key].map(value => value * amount);
    const corner = event.target.dataset.corner;
    const ratio = CROP_RATIOS[crop.ratioKey];
    if (corner && ratio) {
        dx *= ratio[0];
        dy *= ratio[1];
    }
    crop.rect = corner
        ? resizeCrop(crop.rect, corner, dx, dy, cropBounds().width, cropBounds().height, ratio)
        : moveCrop(crop.rect, dx, dy, cropBounds().width, cropBounds().height);
    renderCrop();
});

function applyCrop() {
    if (!crop) return;
    endCropDrag();
    const rect = crop.rect;
    if (rect.x === 0 && rect.y === 0 && rect.width === cropBounds().width && rect.height === cropBounds().height && !project.referenceRect) {
        exitCrop();
        notify('The crop already includes the entire image. No changes made.');
        return;
    }
    const output = document.createElement('canvas');
    output.width = rect.width;
    output.height = rect.height;
    // Board space outside the reference stays transparent, which displays and samples as white.
    const placed = referenceRect(project);
    output.getContext('2d').drawImage(reference, placed.x - rect.x, placed.y - rect.y);
    const referenceData = output.toDataURL('image/png');
    const longest = Math.max(4, Math.min(MAX_SIDE, Math.round(Math.max(
        rect.width / project.width * project.cols, rect.height / project.height * project.rows))));
    const { cols, rows } = gridDimensions(rect.width, rect.height, longest);
    const before = snapshot();
    transformLayers(project, cells => cropCells({ ...project, cells }, rect, cols, rows), cols, rows,
        (x, y) => [Math.floor(((x + 0.5) * project.width / project.cols - rect.x) * cols / rect.width),
            Math.floor(((y + 0.5) * project.height / project.rows - rect.y) * rows / rect.height)],
        [project.width / project.cols * cols / rect.width, 0, 0, project.height / project.rows * rows / rect.height,
            -rect.x * cols / rect.width, -rect.y * rows / rect.height]);
    remember(before);
    Object.assign(project, { width: rect.width, height: rect.height, referenceRect: null, reference: referenceData });
    reference = output;
    prepareSampler();
    cursor = { x: 0, y: 0 };
    changed();
    exitCrop(true);
    notify('Reference and pattern cropped. Painted cells were resampled to the new proportions. Undo restores the original.');
}
action('crop-apply', applyCrop);
document.addEventListener('keydown', event => {
    if (!crop || event.isComposing) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        exitCrop();
        notify('Crop cancelled. Your pattern is unchanged.');
    } else if (event.key === 'Enter' && (event.target.closest('#crop-frame') || event.target.closest('#crop-settings input'))) {
        event.preventDefault();
        // Commit an edited dimension before applying the crop.
        if (event.target.matches('input[type="number"]')) event.target.dispatchEvent(new Event('change'));
        if (!$('crop-error').textContent) applyCrop();
    }
});
for (const id of ['reference-toggle', 'lines-toggle']) $(id).addEventListener('change', render);
$('snapping-toggle').addEventListener('change', () => placement.refreshSnapping());
$('stroke-range').addEventListener('input', () => setStrokeWidth(Number($('stroke-range').value)));
$('stroke-width').addEventListener('change', () => {
    const input = $('stroke-width'), value = Number(input.value);
    if (!input.value.trim() || !Number.isInteger(value) || value < 1 || value > MAX_STROKE) {
        notify(`Width must be a whole number from 1 to ${MAX_STROKE}.`, true);
        updateControls();
        return;
    }
    setStrokeWidth(value);
});
$('stroke-width').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.target.dispatchEvent(new Event('change')); }
});
$('shape-fill').addEventListener('change', updateControls);
$('name').addEventListener('input', () => {
    project.name = $('name').value.trim() || 'Untitled pattern';
    changed();
});
$('name').addEventListener('blur', () => { if (project) $('name').value = project.name; });
action('add-color', () => {
    const color = $('new-color').value.toLowerCase();
    addPaletteColor(color);
});
action('delete-color', () => {
    if (!project || crop || !selected) return;
    const color = selected;
    const index = project.palette.indexOf(color);
    if (index < 0) throw new Error('Select a color in the palette before deleting it.');
    project.palette.splice(index, 1);
    selected = project.palette[Math.min(index, project.palette.length - 1)] || null;
    if (selected) $('new-color').value = selected;
    changed();
    renderPalette();
    placement.refresh();
    notify(`Removed ${color} from the palette. Painted pixels are unchanged.`);
    if (!selected) $('new-color').focus({ preventScroll: true });
});

const importPreview = createImportPreview({
    loadLines: loadYarnLines, yarnOption, renderYarnColors,
    confirm: async ({ source, name, result, yarn }) => {
        if (!(await activate({
            version: 1, id: crypto.randomUUID(), name: name.slice(0, 80) || 'Untitled pattern',
            width: source.width, height: source.height, reference: source.toDataURL('image/png'),
            cols: result.cols, rows: result.rows, palette: result.palette, cells: result.cells,
            updatedAt: Date.now(),
        }))) return false;
        if (yarn) setYarnLine(yarn);
        changed();
        notify(`Created ${result.cols} x ${result.rows} editable cells with ${result.palette.length} colors. Your reference and estimated colors are preserved.`);
        return true;
    },
});
let imageUploadGeneration = 0;
$('new-dialog').addEventListener('close', () => { imageUploadGeneration++; });
const newProjectTabs = [$('blank-tab'), $('image-tab')];
function selectNewProjectTab(tab) {
    for (const button of newProjectTabs) {
        const active = button === tab;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        $(button.getAttribute('aria-controls')).hidden = !active;
    }
    importPreview.updateDialogWidth();
    $('new-dialog').querySelector('.dialog-message').textContent = '';
}
for (const tab of newProjectTabs) {
    tab.addEventListener('click', () => selectNewProjectTab(tab));
    tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? newProjectTabs[0]
            : event.key === 'End' ? newProjectTabs[1]
            : newProjectTabs[1 - newProjectTabs.indexOf(tab)];
        selectNewProjectTab(next);
        next.focus();
    });
}
function openNewProject() {
    $('project-dialog').close();
    importPreview.reset();
    selectNewProjectTab($('blank-tab'));
    $('new-dialog').showModal();
}
action('upload', openNewProject);
action('new-project', openNewProject);
action('new-image', () => { $('image-file').click(); });
$('blank-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
        const cols = Number($('blank-cols').value), rows = Number($('blank-rows').value);
        if (![cols, rows].every(value => Number.isInteger(value) && value >= 1 && value <= MAX_SIDE)) {
            throw new Error(`Choose whole numbers from 1 to ${MAX_SIDE} for columns and rows.`);
        }
        // A transparent backing keeps blank projects compatible with existing backups and board transforms.
        const backing = document.createElement('canvas');
        backing.width = cols;
        backing.height = rows;
        if (!(await activate({
            version: 1, id: crypto.randomUUID(), name: 'Untitled pattern',
            width: cols, height: rows, cols, rows, blank: true,
            reference: backing.toDataURL('image/png'), palette: [],
            cells: Array(cols * rows).fill(null), updatedAt: Date.now(),
        }))) return;
        $('new-dialog').close();
        changed();
        notify('Your blank canvas is ready. Add a palette color to start painting.');
    } catch (error) {
        $('new-dialog').querySelector('.dialog-message').textContent = error.message;
    } finally { button.disabled = false; }
});
action('back-projects', async () => {
    if (!(await protectUnsaved())) return;
    clearTimeout(timer);
    clearTimeout(zoomSettleTimer);
    setSpaceHeld(false);
    exitCrop();
    placement.cancel();
    if (yarnLine) setYarnLine('');
    project = null;
    reference = null;
    history = [];
    future = [];
    dirty = false;
    revision++;
    selected = null;
    paintedTiles = null;
    $('canvas-wrap').hidden = true;
    $('empty').hidden = false;
    $('workspace').classList.remove('editing', 'moving');
    $('workspace').scrollTo(0, 0);
    $('name').value = 'Untitled pattern';
    $('dimensions').textContent = 'No pattern open';
    $('save-state').textContent = 'Stored only in this browser';
    updateControls();
    renderPalette();
    render();
    await renderHome();
    $('upload').focus({ preventScroll: true });
    notify('Choose a project or create a new one.');
});
$('image-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const upload = ++imageUploadGeneration, estimate = $('estimate-image').checked;
    importPreview.reset();
    let url;
    try {
        if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP, or GIF image.');
        url = URL.createObjectURL(file);
        const image = await decodeImage(url);
        if (upload !== imageUploadGeneration || !$('new-dialog').open) return;
        if (estimate && $('estimate-image').checked) {
            importPreview.start(imageReference(image), file.name.replace(/\.[^.]+$/, ''));
            return;
        }
        if (await newFromImage(image, file.name.replace(/\.[^.]+$/, ''))) $('new-dialog').close();
    } catch (error) {
        if (upload !== imageUploadGeneration || !$('new-dialog').open) return;
        if ($('new-dialog').open) $('new-dialog').querySelector('.dialog-message').textContent = error.message;
        report(error);
    }
    finally { if (url) URL.revokeObjectURL(url); }
});
action('demo', async () => {
    const sample = document.createElement('canvas');
    sample.width = 240;
    sample.height = 180;
    const ctx = sample.getContext('2d');
    ctx.fillStyle = '#f4ecd6'; ctx.fillRect(0, 0, 240, 180);
    ctx.fillStyle = '#789078'; ctx.fillRect(110, 80, 20, 100);
    ctx.beginPath(); ctx.ellipse(90, 130, 32, 13, 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#bb543d';
    for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        ctx.beginPath(); ctx.arc(120 + Math.cos(angle) * 32, 65 + Math.sin(angle) * 32, 20, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#d6ab57'; ctx.beginPath(); ctx.arc(120, 65, 22, 0, Math.PI * 2); ctx.fill();
    await newFromImage(sample, 'A flower, in stitches');
});

async function listProjects() {
    await storeReady;
    $('project-list').replaceChildren();
    if (!store) throw new Error('Browser saves are unavailable. Import or download project backups instead.');
    const projects = await store.run('readonly', objectStore => objectStore.getAll());
    if (!projects.length) $('project-list').textContent = 'No saved projects yet. Start with an image or try the sample.';
    projects.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const data of projects) {
        const row = document.createElement('div');
        row.className = 'project-row';
        const info = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = data.name;
        const detail = document.createElement('small');
        detail.textContent = `${data.cols} x ${data.rows} cells | ${new Date(data.updatedAt).toLocaleString()}`;
        info.append(title, detail);
        const buttons = document.createElement('div');
        buttons.className = 'project-actions';
        const open = document.createElement('button');
        open.textContent = project?.id === data.id ? 'Current project' : 'Open';
        open.disabled = project?.id === data.id;
        open.addEventListener('click', async () => {
            try { if (await activate(data)) notify('Project opened from this browser.'); }
            catch (error) { report(error); }
        });
        const remove = document.createElement('button');
        remove.textContent = 'Delete';
        remove.disabled = project?.id === data.id;
        remove.setAttribute('aria-label', `Delete ${data.name}`);
        remove.addEventListener('click', async () => {
            if (!confirm(`Delete "${data.name}" from this browser? This cannot be undone.`)) return;
            try {
                await store.run('readwrite', objectStore => objectStore.delete(data.id));
                await listProjects();
            } catch (error) { report(error); }
        });
        buttons.append(open, remove);
        row.append(info, buttons);
        $('project-list').append(row);
    }
}

action('projects', async () => {
    $('project-dialog').querySelector('.dialog-message').textContent = '';
    $('project-dialog').showModal();
    // Keep backup/import controls usable if browser storage is blocked.
    try { await save(); await listProjects(); }
    catch (error) { $('project-list').textContent = error.message; report(error); }
});

// Start screen: a scrollable list with "Create new" first, then saved projects newest first.
// Each row's background is a crisp render of the project, cropped to a horizontal slice.
const PREVIEW_WIDTH = 720;
const previews = new Map();
let homeProjects = [];

// Faded reference with the painted cells on top, scaled by a whole number so cells stay square.
async function projectPreview(data) {
    const key = `${data.id}:${data.updatedAt}`;
    let art = previews.get(key);
    if (!art) {
        const scale = Math.max(1, Math.ceil(PREVIEW_WIDTH / data.cols));
        art = document.createElement('canvas');
        art.width = data.cols * scale;
        art.height = data.rows * scale;
        const ctx = art.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, art.width, art.height);
        try {
            const image = await decodeImage(data.reference);
            const rect = referenceRect(data), scaleX = art.width / data.width, scaleY = art.height / data.height;
            ctx.globalAlpha = 0.35;
            ctx.drawImage(image, rect.x * scaleX, rect.y * scaleY, rect.width * scaleX, rect.height * scaleY);
            ctx.globalAlpha = 1;
        } catch { /* A broken reference still shows the painted cells. */ }
        const cells = document.createElement('canvas');
        cells.width = data.cols;
        cells.height = data.rows;
        const cellContext = cells.getContext('2d');
        const pixels = cellContext.createImageData(data.cols, data.rows);
        const words = new Uint32Array(pixels.data.buffer);
        words.set(flattenPixels(data));
        cellContext.putImageData(pixels, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cells, 0, 0, art.width, art.height);
        for (const old of previews.keys()) if (old.startsWith(`${data.id}:`)) previews.delete(old);
        previews.set(key, art);
    }
    const copy = document.createElement('canvas');
    copy.width = art.width;
    copy.height = art.height;
    copy.getContext('2d').drawImage(art, 0, 0);
    return copy;
}

// Shows the band of rows with the most painted cells (centered when nothing is painted).
function focusPreviewSlice(preview, data) {
    const box = preview.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const visibleRows = data.rows * Math.min(1, (box.height / box.width) / (data.rows / data.cols));
    const band = Math.ceil(visibleRows);
    if (band >= data.rows) { preview.style.objectPosition = '50% 50%'; return; }
    const painted = new Uint32Array(data.rows);
    data.cells.forEach((color, index) => { if (color !== null) painted[Math.floor(index / data.cols)]++; });
    let sum = 0;
    for (let row = 0; row < band; row++) sum += painted[row];
    let best = sum, bestStart = 0;
    for (let row = band; row < data.rows; row++) {
        sum += painted[row] - painted[row - band];
        if (sum > best) { best = sum; bestStart = row - band + 1; }
    }
    const percent = best ? bestStart / (data.rows - band) * 100 : 50;
    preview.style.objectPosition = `50% ${percent.toFixed(2)}%`;
}

function projectRow(data) {
    const row = document.createElement('li');
    row.className = 'home-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'row-open';
    const editedAt = new Date(data.updatedAt);
    open.title = `${data.name}\n${data.cols} x ${data.rows} cells\nEdited ${editedAt.toLocaleString()}`;
    open.setAttribute('aria-label', `Open ${data.name}, ${data.cols} by ${data.rows} cells, edited ${editedAt.toLocaleString()}`);
    const art = document.createElement('span');
    art.className = 'row-art loading';
    art.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'row-text';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = data.name;
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    meta.textContent = `${data.cols} \u00d7 ${data.rows} \u00b7 ${editedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    text.append(name, meta);
    open.append(art, text);
    open.addEventListener('click', async () => {
        try { if (await activate(data)) notify(`Opened ${data.name}.`); }
        catch (error) { report(error); }
    });
    const menu = document.createElement('details');
    menu.className = 'row-menu';
    const summary = document.createElement('summary');
    summary.setAttribute('aria-label', `More options for ${data.name}`);
    summary.title = 'More options';
    summary.textContent = '\u22ee';
    const actions = document.createElement('div');
    actions.className = 'row-menu-actions';
    const backup = document.createElement('button');
    backup.type = 'button';
    backup.textContent = 'Download';
    backup.addEventListener('click', () => {
        menu.open = false;
        download(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'pattern.json', data.name);
        notify(`Downloaded a backup of ${data.name}.`);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
        menu.open = false;
        if (!confirm(`Delete "${data.name}" from this browser? This cannot be undone.`)) return;
        try {
            await store.run('readwrite', objectStore => objectStore.delete(data.id));
            previews.delete(`${data.id}:${data.updatedAt}`);
            homeProjects = homeProjects.filter(item => item.id !== data.id);
            drawHome();
            $('upload').focus({ preventScroll: true });
            notify(`Deleted ${data.name}.`);
        } catch (error) { report(error); }
    });
    actions.append(backup, remove);
    menu.append(summary, actions);
    menu.addEventListener('keydown', event => {
        if (event.key === 'Escape' && menu.open) {
            event.preventDefault();
            menu.open = false;
            summary.focus({ preventScroll: true });
        }
    });
    row.append(open, menu);
    projectPreview(data)
        .then(preview => {
            art.classList.remove('loading');
            art.replaceChildren(preview);
            focusPreviewSlice(preview, data);
        })
        .catch(() => { art.classList.remove('loading'); art.classList.add('broken'); });
    return row;
}

function drawHome() {
    $('recent-list').querySelectorAll('.home-row:not(.create-row)').forEach(row => row.remove());
    $('recent-list').append(...homeProjects.map(projectRow));
    $('recent-title').textContent = homeProjects.length ? `Your projects (${homeProjects.length})` : 'Your projects';
    if (store) $('recent-status').textContent = homeProjects.length ? '' : 'Projects you save will appear here.';
    // Returning users came for their projects, so compact the intro to bring the list up.
    $('empty').classList.toggle('has-projects', homeProjects.length > 0);
}

async function renderHome() {
    await storeReady;
    if (project) return;
    if (!store) {
        homeProjects = [];
        $('recent-status').textContent = 'Browser saves are unavailable here. Import a project backup to keep working.';
    } else {
        try {
            homeProjects = (await store.run('readonly', objectStore => objectStore.getAll())).sort((a, b) => b.updatedAt - a.updatedAt);
        } catch (error) {
            homeProjects = [];
            $('recent-status').textContent = `Saved projects could not be loaded: ${error.message}`;
        }
    }
    if (!project) drawHome();
}

// The visible slice depends on the row's shape, so refit it when the list width changes.
let homeWidth = 0;
new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (project || width === homeWidth) return;
    homeWidth = width;
    $('recent-list').querySelectorAll('.home-row:not(.create-row)').forEach((row, index) => {
        const preview = row.querySelector('.row-art canvas');
        if (preview && homeProjects[index]) focusPreviewSlice(preview, homeProjects[index]);
    });
}).observe($('recent-list'));
action('home-import', () => { $('project-file').click(); });
document.addEventListener('pointerdown', event => {
    document.querySelectorAll('.row-menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
}, true);
document.addEventListener('toggle', event => {
    // Only one row menu open at a time.
    if (event.target.matches?.('.row-menu[open]')) {
        document.querySelectorAll('.row-menu[open]').forEach(menu => { if (menu !== event.target) menu.open = false; });
    }
}, true);
action('save-now', async () => { await save(); await listProjects(); notify('Project saved on this device.'); });
action('import-project', () => { $('project-file').click(); });
$('project-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        if (file.size > 8 * 1024 * 1024) throw new Error('Project backups must be smaller than 8 MB.');
        const data = validateProject(JSON.parse(await file.text()));
        // Import as a copy, never overwrite another project's local save.
        if (!(await activate({ ...data, id: crypto.randomUUID(), updatedAt: Date.now() }))) return;
        changed();
        notify('Backup imported as a new project.');
    } catch (error) { report(error); }
});

function download(blob, extension, name = project.name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const filename = name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'pattern';
    link.download = `${filename}.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

action('backup', () => {
    download(new Blob([JSON.stringify(serializeLayers(project))], { type: 'application/json' }), 'pattern.json');
    notify('Project backup downloaded. Keep this file to restore your editable pattern and reference.');
});
action('export', () => {
    $('export-dialog').querySelector('.dialog-message').textContent = '';
    $('export-dialog').showModal();
});
action('download-image', async () => {
    const scale = Number($('export-scale').value);
    const longest = Math.max(project.cols, project.rows) * scale;
    if (longest > 5000) throw new Error('Choose fewer pixels per cell to stay within the 5,000px export limit.');
    const format = $('format').value;
    const output = document.createElement('canvas');
    // Preserve reference proportions, including grids with rounded cell counts.
    const dimensions = gridDimensions(project.width, project.height, longest);
    output.width = dimensions.cols;
    output.height = dimensions.rows;
    const ctx = output.getContext('2d');
    if (format === 'jpeg') {
        ctx.fillStyle = $('export-background').value;
        ctx.fillRect(0, 0, output.width, output.height);
    }
    const yarnColors = Boolean(yarnLine) && $('export-yarn').checked;
    const composite = createLayerCompositor(project);
    for (let index = 0; index < project.cols * project.rows; index++) {
        const pixel = composite(index);
        if (!pixel) continue;
        const x = index % project.cols, y = Math.floor(index / project.cols);
        const left = Math.round(x * output.width / project.cols), top = Math.round(y * output.height / project.rows);
        const right = Math.round((x + 1) * output.width / project.cols), bottom = Math.round((y + 1) * output.height / project.rows);
        ctx.fillStyle = yarnColors ? displayColor(pixelColor(pixel, true)) : pixelColor(pixel);
        ctx.globalAlpha = yarnColors ? 1 : Math.round(pixel[3] * 255) / 255;
        ctx.fillRect(left, top, right - left, bottom - top);
    }
    const blob = await new Promise(resolve => output.toBlob(resolve, `image/${format}`, 0.95));
    if (!blob || blob.type !== `image/${format}`) throw new Error(`This browser cannot export ${format.toUpperCase()}. Please choose PNG.`);
    download(blob, format === 'jpeg' ? 'jpg' : format);
    notify(`Exported ${output.width} x ${output.height}px ${format.toUpperCase()}${yarnColors ? ` in ${yarnLine.name} yarn colors` : ''} without reference or gridlines.`);
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
new ResizeObserver(render).observe($('workspace'));
largeScreen.addEventListener('change', () => {
    finishStroke();
    if (!largeScreen.matches) {
        exitCrop();
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    }
    else render();
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { finishStroke(); save().catch(report); }
});
window.addEventListener('beforeunload', event => {
    finishStroke();
    if (dirty || placement.active) { event.preventDefault(); event.returnValue = ''; }
});
renderPalette();
updateControls();
renderHome();
