import { MAX_SIDE, parseGridSize, gridDimensions, resizeCells, cropCells, extendCells, mirrorCells, rotateCells, referenceRect, extendBoard, mirrorBoard, rotateBoard, flood, line, validateProject, openStore } from './model.js';
import { CROP_RATIOS, fitCrop, moveCrop, resizeCrop } from './crop.js';
import { createPlacementEditor } from './placement.js';
import { MAX_STROKE, brush, strokeWidth } from './objects.js';
import { USABLE_SCORE, colorUsage, findClosestColor, matchYarnLine, prepareYarnLines, rankYarnLines } from './palette.js';

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const context = canvas.getContext('2d');
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
const STROKE_KEY = 'pattern-studio-stroke-widths';
const strokeWidths = { paint: 1, line: 1, shape: 1 };
try {
    const saved = JSON.parse(localStorage.getItem(STROKE_KEY) || '{}');
    for (const key of Object.keys(strokeWidths)) strokeWidths[key] = strokeWidth(saved[key]);
} catch { /* Widths fall back to 1 when storage is unavailable. */ }
const placement = createPlacementEditor({
    canvas, getProject: () => project, getColor: () => selected, getStroke: kind => strokeWidths[kind],
    redraw: () => renderPlacement(), updateControls, notify,
    commitPixels(pixels) {
        if (!project || !Array.from(pixels).some(([index, color]) => project.cells[index] !== color)) return;
        remember(snapshot());
        for (const [index, color] of pixels) project.cells[index] = color;
        changed();
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
        if (!['undo', 'redo', 'zoom-in', 'zoom-out', 'add-color', 'delete-color', 'copy', 'cut', 'paste'].includes(id)) placement.commit();
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
        cols: project.cols, rows: project.rows, cells: project.cells.slice(),
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
    const { referenceImage, ...data } = saved;
    Object.assign(project, data);
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
            let size = item.cells.length;
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
}

async function save() {
    clearTimeout(timer);
    if (!project || !dirty) return;
    await storeReady;
    if (!store) throw new Error('Could not save in this browser. Download a project backup before leaving. ' + (storageError?.message || ''));
    const data = structuredClone(project);
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
    if (project.id === data.id && revision === savedRevision) {
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
    return ['paint', 'line', 'shape', 'select'].includes(tool) ? 'object' : null;
}

function activeStrokeKind() {
    if (placement.active) {
        if (placement.kind === 'line') return 'line';
        return placement.kind === 'shape' && !placement.filled ? 'shape' : null;
    }
    if (tool === 'shape') return $('shape-fill').value === 'filled' ? null : 'shape';
    return ['paint', 'line'].includes(tool) ? tool : null;
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
    for (const id of ['name', 'backup', 'export', 'grid-toggle', 'crop-start', 'reference-toggle', 'lines-toggle']) $(id).disabled = !active || Boolean(crop);
    $('projects').disabled = Boolean(crop);
    document.querySelectorAll('[data-tool]').forEach(button => { button.disabled = !active || Boolean(crop); });
    $('undo').disabled = !active || Boolean(crop) || (!history.length && !placement.active);
    $('redo').disabled = !active || Boolean(crop) || placement.active || !future.length;
    $('copy').disabled = !active || Boolean(crop) || !placement.selecting;
    $('cut').disabled = !active || Boolean(crop) || !placement.selecting;
    $('paste').disabled = !active || Boolean(crop) || !placement.canPaste;
    if (placement.active && !crop) settingsPanel = 'object';
    for (const panel of ['object', 'grid', 'crop']) $(`${panel}-settings`).hidden = !active || settingsPanel !== panel;
    $('settings-dock').hidden = !active || !settingsPanel;
    $('grid-toggle').setAttribute('aria-expanded', String(active && settingsPanel === 'grid'));
    $('crop-start').setAttribute('aria-expanded', String(active && settingsPanel === 'crop'));
    $('shape-options').hidden = tool !== 'shape' || (placement.active && placement.kind !== 'shape');
    $('object-transform').hidden = placement.active ? !['shape', 'paste'].includes(placement.kind) : tool !== 'shape';
    $('placement-apply').disabled = !placement.active || placement.selecting;
    $('placement-cancel').disabled = !placement.active;
    for (const key of ['width', 'height', 'angle']) $(`object-${key}`).disabled = !placement.active;
    const strokeKind = activeStrokeKind();
    $('stroke-options').hidden = !strokeKind;
    $('placement-actions').hidden = $('object-help').hidden = tool === 'paint' && !placement.active;
    if (strokeKind) {
        $('stroke-label').textContent = { paint: 'Brush size', line: 'Line width', shape: 'Outline width' }[strokeKind];
        $('stroke-width').value = $('stroke-range').value = strokeWidths[strokeKind];
    }
    $('save-now').disabled = !active;
    $('zoom-out').disabled = !active || zoom <= 1;
    $('zoom-in').disabled = !active || zoom >= 8;
    if (active) {
        const rect = referenceRect(project);
        $('dimensions').textContent = `${project.cols} x ${project.rows} cells | Reference ${rect.width} x ${rect.height}px`;
        $('grid-size').value = Math.max(project.cols, project.rows);
        $('grid-number').value = $('grid-size').value;
    }
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
        try { yarn = findClosestColor(color, yarnLine.colors); } catch { yarn = color; }
        yarnMap.set(color, yarn);
    }
    return yarn;
}

function refreshYarnMapping() {
    if (!yarnLine || !project) return;
    const previous = yarnMap;
    yarnMatch = matchYarnLine(colorUsage(project.cells, project.palette), yarnLine);
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
    yarnLine = name ? yarnLines.find(line => line.name === name) || null : null;
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
    const counts = new Map(colorUsage(project.cells, project.palette).map(item => [item.color, item.count]));
    const rows = [...yarnMatch.mapping].sort((a, b) => (counts.get(b[0]) || 0) - (counts.get(a[0]) || 0));
    for (const [color, match] of rows) {
        const item = document.createElement('li');
        const arrow = document.createElement('span');
        arrow.textContent = '\u2192';
        const yarn = document.createElement('span');
        yarn.textContent = match.yarn;
        const score = document.createElement('span');
        score.className = 'yarn-match-score';
        if (match.score < USABLE_SCORE) score.classList.add('weak');
        score.textContent = match.shared ? 'no free yarn' : `${Math.round(match.score)}`;
        score.title = match.shared
            ? 'This line has fewer yarns than your pattern has distinct colors, so this color reuses its nearest yarn.'
            : `Match score ${Math.round(match.score)} of 100`;
        item.title = `${color} \u2192 ${match.yarn}`;
        item.append(swatchChip(color), arrow, swatchChip(match.yarn), yarn, score);
        list.append(item);
    }
}

function renderYarnRanking(ranking, colorCount) {
    const list = $('yarn-ranking');
    list.replaceChildren();
    $('yarn-status').textContent = !colorCount
        ? 'Add or paint colors to get yarn recommendations.'
        : `Best of ${yarnLines.length} lines for your ${colorCount} color${colorCount === 1 ? '' : 's'}. Scores weigh how close each color is and how much of the pattern uses it.`;
    ranking.forEach((result, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'yarn-option';
        button.dataset.line = result.name;
        button.setAttribute('aria-pressed', String(yarnLine?.name === result.name));
        const rank = document.createElement('span');
        rank.className = 'yarn-rank';
        rank.textContent = index === 0 ? 'Best' : `#${index + 1}`;
        const name = document.createElement('span');
        name.className = 'yarn-name';
        name.textContent = result.name;
        const score = document.createElement('span');
        score.className = 'yarn-score';
        score.textContent = Math.round(result.score);
        score.title = 'Overall match score out of 100';
        const detail = document.createElement('span');
        detail.className = 'yarn-detail';
        detail.textContent = `${result.usable} of ${result.total} colors usable \u00b7 ${result.size} yarns in line`;
        const strip = document.createElement('span');
        strip.className = 'yarn-strip';
        strip.setAttribute('aria-hidden', 'true');
        for (const match of result.mapping.values()) {
            const part = document.createElement('span');
            part.style.background = match.yarn;
            strip.append(part);
        }
        button.append(rank, name, score, detail, strip);
        button.addEventListener('click', () => setYarnLine(yarnLine?.name === result.name ? '' : result.name));
        item.append(button);
        list.append(item);
    });
    // Mirror the top matches in the selector so keyboard users can reach them first.
    $('yarn-line').querySelector('optgroup[data-recommended]')?.remove();
    if (ranking.length) {
        const group = document.createElement('optgroup');
        group.label = 'Recommended';
        group.dataset.recommended = '';
        group.append(...ranking.map((result, index) => new Option(`${index + 1}. ${result.name} - ${Math.round(result.score)}`, result.name)));
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
    const usage = colorUsage(project.cells, project.palette);
    renderYarnRanking(rankYarnLines(usage, yarnLines, 5), usage.length);
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
    const fit = Math.min((workspace.clientWidth - 48) / project.width, (workspace.clientHeight - 48) / project.height);
    if (fit <= 0) return null;
    const width = Math.max(1, Math.floor(project.width * fit * zoom));
    const height = Math.max(1, Math.floor(project.height * fit * zoom));
    wrap.style.width = `${Math.max(workspace.clientWidth, width + 48)}px`;
    wrap.style.height = `${Math.max(workspace.clientHeight, height + 48)}px`;
    // Keep the display bitmap bounded on large monitors; CSS zoom and hit testing remain exact.
    const dpr = Math.min(devicePixelRatio || 1, 2, 8192 / Math.max(width, height));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    return { bitmapWidth: Math.round(width * dpr), bitmapHeight: Math.round(height * dpr) };
}

function render({ paint = true } = {}) {
    $('sample-preview').hidden = true;
    clearTimeout(zoomSettleTimer);
    zoomSettleTimer = 0;
    if (!project || !largeScreen.matches) return;
    const size = layoutCanvas();
    if (!size) return;
    const { bitmapWidth, bitmapHeight } = size;
    // Reassigning canvas dimensions reallocates the bitmap, so only do it when the size changes.
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
        canvas.width = bitmapWidth;
        canvas.height = bitmapHeight;
    }
    paintedTiles = null;
    if (paint) paintVisibleTiles();
    drawnPreview = previewBounds();
    drawnCursor = cursorVisible();
    renderCrop();
    placement.render();
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
    const cells = project.cells, cols = project.cols, recolor = Boolean(yarnLine);
    for (let y = y0; y < y1; y++) {
        for (let index = y * cols + x0, end = y * cols + x1; index < end; index++) {
            const color = cells[index];
            cellWords[index] = color === null ? 0 : colorWord(recolor ? displayColor(color) : color);
        }
    }
    if (withPreview) for (const [index, color] of placement.preview()) {
        const x = index % cols, y = (index - x) / cols;
        if (x >= x0 && x < x1 && y >= y0 && y < y1) cellWords[index] = colorWord(recolor ? displayColor(color) : color);
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
let drawnPreview = null, drawnCursor = false;

function cursorVisible() {
    return Boolean(project) && !crop && !placement.active && tool !== 'move' && keyboardFocus;
}

// Placement edits only change the cells under the old and new previews, so repaint just those boxes.
function renderPlacement() {
    if (!project || !largeScreen.matches || !canvas.width) return render();
    const next = previewBounds();
    for (const box of [drawnPreview, next]) if (box) renderCells(box.minX, box.minY, box.maxX, box.maxY);
    drawnPreview = next;
    if (drawnCursor !== cursorVisible()) renderCells(cursor.x, cursor.y, cursor.x, cursor.y);
    drawnCursor = cursorVisible();
    placement.render();
}

function paintLayers(x0, y0, x1, y1) {
    const cellWidth = project.width / project.cols, cellHeight = project.height / project.rows;
    context.setTransform(canvas.width / project.width, 0, 0, canvas.height / project.height, 0, 0);
    context.fillStyle = '#ffffff';
    context.fillRect(x0 * cellWidth, y0 * cellHeight, (x1 - x0) * cellWidth, (y1 - y0) * cellHeight);
    if (crop || tool === 'sample' || $('reference-toggle').checked) {
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
    if (!crop && tool !== 'sample' && $('lines-toggle').checked) {
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
    project = data;
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
    $('yarn-line').querySelector('optgroup[data-recommended]')?.remove();
    $('yarn-menu').open = false;
    if (yarnLine) setYarnLine('');
    updateControls();
    clearGridError();
    renderPalette();
    render();
    return true;
}

async function newFromImage(image, name) {
    const size = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * size));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * size));
    const thumbnail = document.createElement('canvas');
    thumbnail.width = width;
    thumbnail.height = height;
    thumbnail.getContext('2d').drawImage(image, 0, 0, width, height);
    const { cols, rows } = gridDimensions(width, height, 50);
    const activated = await activate({
        version: 1, id: crypto.randomUUID(), name: name.slice(0, 80) || 'Untitled pattern',
        width, height, cols, rows, reference: thumbnail.toDataURL('image/png'),
        palette: [], cells: Array(cols * rows).fill(null), updatedAt: Date.now(),
    });
    if (!activated) return;
    changed();
    notify('Your reference is ready. Add a color or use Color sampler, then choose Paint. The reference is never included in exports.');
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
    const color = tool === 'erase' ? null : selected;
    if (tool === 'fill') {
        return flood(project.cells, project.cols, project.rows, x, y, color);
    }
    if (tool === 'paint') {
        let painted = false;
        brush(x, y, strokeWidths.paint, (bx, by) => {
            if (bx < 0 || by < 0 || bx >= project.cols || by >= project.rows) return;
            const index = by * project.cols + bx;
            if (project.cells[index] !== color) { project.cells[index] = color; painted = true; }
        });
        return painted;
    }
    const index = y * project.cols + x;
    if (project.cells[index] === color) return false;
    project.cells[index] = color;
    return true;
}

function renderStroke(from, to) {
    const reach = tool === 'paint' ? strokeWidth(strokeWidths.paint) : 1;
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
    stroke = { id: event.pointerId, before: snapshot(), last: position, changed: false };
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
        previewSample(event);
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
canvas.addEventListener('pointerleave', () => { $('sample-preview').hidden = true; });
$('workspace').addEventListener('scroll', () => {
    $('sample-preview').hidden = true;
    paintVisibleTiles();
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, finishStroke);
canvas.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') $('sample-preview').hidden = true;
});
canvas.addEventListener('pointercancel', () => { $('sample-preview').hidden = true; });
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

$('workspace').addEventListener('pointerdown', event => {
    if (!project || crop || tool !== 'move' || !largeScreen.matches || pan || event.button !== 0 || !event.isPrimary) return;
    const workspace = $('workspace');
    if (!inWorkspaceViewport(event)) return;
    event.preventDefault();
    pointerFocus = true;
    canvas.focus({ preventScroll: true });
    pointerFocus = false;
    keyboardFocus = false;
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: workspace.scrollLeft, top: workspace.scrollTop };
    workspace.setPointerCapture(event.pointerId);
    workspace.classList.add('panning');
});
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
    settingsPanel = toolPanel();
    canvas.classList.toggle('sampling', tool === 'sample');
    $('workspace').classList.toggle('moving', tool === 'move');
    $('sample-preview').hidden = true;
    document.querySelectorAll('[data-tool]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    updateControls();
    render();
    if (tool === 'sample') notify('Hover over the reference to preview a color. Click or tap to add it to your palette. Choose Paint when ready.');
    if (tool === 'move') notify('Drag the canvas to move around the zoomed view without painting. Arrow keys also pan; Shift moves farther. Choose Paint to resume drawing.');
    if (['line', 'shape', 'select'].includes(tool)) notify(tool === 'select'
        ? 'Drag a selection on the grid, then Copy or Cut and Paste.'
        : 'Drag to draw. Adjust handles and palette color, then click away or Apply to finalize.');
}));

function undo() {
    if (crop) return;
    if (placement.active) { placement.cancel(); return; }
    finishStroke();
    if (!history.length) return;
    future.push(snapshot());
    restoreSnapshot(history.pop());
    changed(); render();
}

function redo() {
    if (crop) return;
    if (placement.active) return;
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
    if (!placement.active || event.button !== 0 || !event.isPrimary ||
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
    zoom = Math.max(1, Math.min(8, value));
    updateControls();
    // Resize the element now and let the browser stretch the existing bitmap; reallocating and
    // repainting it at full resolution costs far more, so that waits until zooming pauses.
    const size = largeScreen.matches ? layoutCanvas() : null;
    // A bitmap much larger than needed makes newly revealed tiles expensive, so shrink it right away.
    const full = !size || canvas.width > size.bitmapWidth * 1.5;
    // Paint after the scroll is re-anchored so only the tiles that end up visible are drawn.
    if (full) render({ paint: false });
    const next = canvas.getBoundingClientRect();
    workspace.scrollLeft += next.left + centerX * next.width - anchorX;
    workspace.scrollTop += next.top + centerY * next.height - anchorY;
    paintVisibleTiles();
    if (full) return;
    clearTimeout(zoomSettleTimer);
    zoomSettleTimer = setTimeout(render, ZOOM_SETTLE_MS);
}
const ZOOM_SETTLE_MS = 150;
action('zoom-in', () => setZoom(zoom + 0.25));
action('zoom-out', () => setZoom(zoom - 0.25));
document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) ||
        !project || !largeScreen.matches || document.querySelector('dialog[open]')) return;
    const step = ['+', '='].includes(event.key) ? 1 : ['-', '_'].includes(event.key) ? -1 : 0;
    if (!step) return;
    // Zoom the pattern instead of the browser page; at the limits the shortcut is still consumed.
    event.preventDefault();
    const button = $(step > 0 ? 'zoom-in' : 'zoom-out');
    if (!button.disabled) setZoom(zoom + step * 0.25);
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
    const next = Math.max(1, Math.min(8, zoom + step * 0.25));
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
    remember(snapshot());
    project.cells = resizeCells(project.cells, project.cols, project.rows, cols, rows);
    project.cols = cols;
    project.rows = rows;
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

function applyCanvasEdit(changes, output, message) {
    remember(snapshot());
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
        `Added ${added} ${where}. Undo removes ${left + right + top + bottom === 1 ? 'it' : 'them'}.`);
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
        `Mirrored ${axis === 'horizontal' ? 'left to right' : 'top to bottom'}.`);
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
        `Rotated 90\u00b0 ${clockwise ? 'right' : 'left'}.`);
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
    $('workspace').scrollTo(applied ? 0 : previous.x, applied ? 0 : previous.y);
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
    const cells = cropCells(project, rect, cols, rows);
    remember(snapshot());
    Object.assign(project, { width: rect.width, height: rect.height, referenceRect: null, cols, rows, cells, reference: referenceData });
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

action('upload', () => { $('image-file').click(); });
action('new-project', () => { $('image-file').click(); });
$('image-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    let url;
    try {
        if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP, or GIF image.');
        url = URL.createObjectURL(file);
        const image = await decodeImage(url);
        await newFromImage(image, file.name.replace(/\.[^.]+$/, ''));
    } catch (error) { report(error); }
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
        data.cells.forEach((color, index) => { if (color !== null) words[index] = colorWord(color); });
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
    download(new Blob([JSON.stringify(project)], { type: 'application/json' }), 'pattern.json');
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
    project.cells.forEach((color, index) => {
        if (color === null) return;
        const x = index % project.cols, y = Math.floor(index / project.cols);
        const left = Math.round(x * output.width / project.cols), top = Math.round(y * output.height / project.rows);
        const right = Math.round((x + 1) * output.width / project.cols), bottom = Math.round((y + 1) * output.height / project.rows);
        ctx.fillStyle = yarnColors ? displayColor(color) : color;
        ctx.fillRect(left, top, right - left, bottom - top);
    });
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
