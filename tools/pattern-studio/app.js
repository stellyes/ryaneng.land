import { MAX_SIDE, parseGridSize, gridDimensions, resizeCells, cropCells, flood, line, validateProject, openStore } from './model.js';
import { CROP_RATIOS, fitCrop, moveCrop, resizeCrop } from './crop.js';
import { createPlacementEditor } from './placement.js';

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
let timer;
let dirty = false;
let revision = 0;
let saveQueue = Promise.resolve();
let store = null;
let storageError = null;
let zoom = 1;
let crop = null;
let cropDrag = null;
const placement = createPlacementEditor({
    canvas, getProject: () => project, getColor: () => selected,
    redraw: render, updateControls, notify,
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
        if (!['undo', 'redo', 'zoom-in', 'zoom-out', 'add-color', 'copy', 'paste'].includes(id)) placement.commit();
    }).then(handler).catch(report));
}

const storeReady = openStore().then(value => { store = value; }).catch(error => {
    storageError = error;
    $('save-state').textContent = 'Browser saving unavailable';
    report(new Error('Browser storage is unavailable. Use Download project to keep your work. ' + error.message));
});

function snapshot() {
    return {
        cols: project.cols, rows: project.rows, cells: project.cells.slice(),
        width: project.width, height: project.height, reference: project.reference, referenceImage: reference,
    };
}

function prepareSampler() {
    sampleCanvas.width = project.width;
    sampleCanvas.height = project.height;
    // Sample the full-opacity reference, with transparency displayed over white.
    sampleContext.fillStyle = '#ffffff';
    sampleContext.fillRect(0, 0, project.width, project.height);
    sampleContext.drawImage(reference, 0, 0);
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

function updateControls() {
    const active = Boolean(project);
    $('workspace-controls').hidden = !active;
    for (const id of ['name', 'backup', 'export', 'grid-toggle', 'crop-start', 'reference-toggle', 'lines-toggle']) $(id).disabled = !active || Boolean(crop);
    $('projects').disabled = Boolean(crop);
    document.querySelectorAll('[data-tool]').forEach(button => { button.disabled = !active || Boolean(crop); });
    $('undo').disabled = !active || Boolean(crop) || (!history.length && !placement.active);
    $('redo').disabled = !active || Boolean(crop) || placement.active || !future.length;
    $('copy').disabled = !active || Boolean(crop) || !placement.selecting;
    $('paste').disabled = !active || Boolean(crop) || !placement.canPaste;
    $('object-settings').hidden = !active || Boolean(crop) || (!placement.active && !['line', 'shape', 'select'].includes(tool));
    $('shape-options').hidden = tool !== 'shape' || (placement.active && placement.kind !== 'shape');
    $('object-transform').hidden = placement.active ? !['shape', 'paste'].includes(placement.kind) : tool !== 'shape';
    $('placement-apply').disabled = !placement.active || placement.selecting;
    $('placement-cancel').disabled = !placement.active;
    for (const key of ['width', 'height', 'angle']) $(`object-${key}`).disabled = !placement.active;
    $('save-now').disabled = !active;
    $('zoom-out').disabled = !active || zoom <= 1;
    $('zoom-in').disabled = !active || zoom >= 8;
    if (active) {
        $('dimensions').textContent = `${project.cols} x ${project.rows} cells | Reference ${project.width} x ${project.height}px`;
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
        button.setAttribute('aria-label', `Paint with ${color}`);
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
}

$('palette-menu').addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('palette-menu').open) {
        event.preventDefault();
        event.stopPropagation();
        $('palette-menu').open = false;
        $('palette-toggle').focus({ preventScroll: true });
    }
});

function render() {
    $('sample-preview').hidden = true;
    if (!project || !largeScreen.matches) return;
    const wrap = $('canvas-wrap');
    const workspace = $('workspace');
    const fit = Math.min((workspace.clientWidth - 48) / project.width, (workspace.clientHeight - 48) / project.height);
    if (fit <= 0) return;
    const width = Math.max(1, Math.floor(project.width * fit * zoom));
    const height = Math.max(1, Math.floor(project.height * fit * zoom));
    wrap.style.width = `${Math.max(workspace.clientWidth, width + 48)}px`;
    wrap.style.height = `${Math.max(workspace.clientHeight, height + 48)}px`;
    // Keep the display bitmap bounded on large monitors; CSS zoom and hit testing remain exact.
    const dpr = Math.min(devicePixelRatio || 1, 2, 8192 / Math.max(width, height));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(canvas.width / project.width, 0, 0, canvas.height / project.height, 0, 0);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, project.width, project.height);
    if (crop || tool === 'sample' || $('reference-toggle').checked) {
        context.globalAlpha = crop || tool === 'sample' ? 1 : 0.6;
        context.drawImage(reference, 0, 0, project.width, project.height);
        context.globalAlpha = 1;
    }
    const cellWidth = project.width / project.cols, cellHeight = project.height / project.rows;
    if (crop || tool !== 'sample') project.cells.forEach((color, index) => {
        if (color === null) return;
        context.fillStyle = color;
        context.fillRect(index % project.cols * cellWidth, Math.floor(index / project.cols) * cellHeight, cellWidth, cellHeight);
    });
    if (!crop && tool !== 'sample') for (const [index, color] of placement.preview()) {
        context.fillStyle = color;
        context.fillRect(index % project.cols * cellWidth, Math.floor(index / project.cols) * cellHeight, cellWidth, cellHeight);
    }
    if (!crop && tool !== 'sample' && $('lines-toggle').checked) {
        context.strokeStyle = 'rgba(30, 45, 35, 0.3)';
        context.lineWidth = project.width / canvas.width;
        context.beginPath();
        for (let x = 0; x <= project.cols; x++) {
            context.moveTo(x * cellWidth, 0);
            context.lineTo(x * cellWidth, project.height);
        }
        for (let y = 0; y <= project.rows; y++) {
            context.moveTo(0, y * cellHeight);
            context.lineTo(project.width, y * cellHeight);
        }
        context.stroke();
    }
    if (!crop && !placement.active && tool !== 'move' && keyboardFocus) {
        context.strokeStyle = '#ffffff';
        context.lineWidth = 3 * project.width / canvas.width;
        context.strokeRect(cursor.x * cellWidth, cursor.y * cellHeight, cellWidth, cellHeight);
        context.strokeStyle = '#202020';
        context.lineWidth = project.width / canvas.width;
        context.strokeRect(cursor.x * cellWidth, cursor.y * cellHeight, cellWidth, cellHeight);
    }
    renderCrop();
    placement.render();
}

async function decodeImage(src) {
    const image = new Image();
    image.src = src;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image has no usable dimensions.');
    return image;
}

async function activate(data) {
    validateProject(data);
    const image = await decodeImage(data.reference);
    if (image.naturalWidth !== data.width || image.naturalHeight !== data.height) throw new Error('The project reference dimensions are invalid.');
    if (!(await protectUnsaved())) return false;
    project = data;
    reference = image;
    prepareSampler();
    selected = data.palette[0] || null;
    tool = 'paint';
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
        Math.max(0, Math.min(project.width - 1, Math.floor(x))),
        Math.max(0, Math.min(project.height - 1, Math.floor(y))), 1, 1).data;
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
    const index = y * project.cols + x;
    if (project.cells[index] === color) return false;
    project.cells[index] = color;
    return true;
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
    canvas.focus({ preventScroll: true });
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
    const position = cellAt(event);
    cursor = position;
    stroke = { id: event.pointerId, before: snapshot(), last: position, changed: false };
    canvas.setPointerCapture(event.pointerId);
    stroke.changed = applyCell(position.x, position.y);
    render();
});
canvas.addEventListener('pointermove', event => {
    if (project && !crop && largeScreen.matches && tool === 'sample') {
        previewSample(event);
        return;
    }
    if (!stroke || stroke.id !== event.pointerId || tool === 'fill') return;
    const position = cellAt(event);
    line(stroke.last.x, stroke.last.y, position.x, position.y, (x, y) => {
        if (applyCell(x, y)) stroke.changed = true;
    });
    stroke.last = position;
    render();
});
canvas.addEventListener('pointerleave', () => { $('sample-preview').hidden = true; });
$('workspace').addEventListener('scroll', () => { $('sample-preview').hidden = true; });
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, finishStroke);
canvas.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') $('sample-preview').hidden = true;
});
canvas.addEventListener('pointercancel', () => { $('sample-preview').hidden = true; });
canvas.addEventListener('focus', () => { keyboardFocus = true; render(); });
canvas.addEventListener('blur', () => { keyboardFocus = false; render(); });

function finishPan() {
    if (!pan) return;
    const id = pan.id;
    pan = null;
    const workspace = $('workspace');
    workspace.classList.remove('panning');
    if (workspace.hasPointerCapture(id)) workspace.releasePointerCapture(id);
}

$('workspace').addEventListener('pointerdown', event => {
    if (!project || crop || tool !== 'move' || !largeScreen.matches || pan || event.button !== 0 || !event.isPrimary) return;
    const workspace = $('workspace');
    const rect = workspace.getBoundingClientRect();
    if (event.clientX >= rect.left + workspace.clientWidth || event.clientY >= rect.top + workspace.clientHeight) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    keyboardFocus = false;
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: workspace.scrollLeft, top: workspace.scrollTop };
    workspace.setPointerCapture(event.pointerId);
    workspace.classList.add('panning');
    render();
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
    canvas.classList.toggle('sampling', tool === 'sample');
    $('workspace').classList.toggle('moving', tool === 'move');
    $('sample-preview').hidden = true;
    document.querySelectorAll('[data-tool]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    updateControls();
    render();
    if (tool === 'sample') notify('Hover over the reference to preview a color. Click or tap to add it to your palette. Choose Paint when ready.');
    if (tool === 'move') notify('Drag the canvas to move around the zoomed view without painting. Arrow keys also pan; Shift moves farther. Choose Paint to resume drawing.');
    if (['line', 'shape', 'select'].includes(tool)) notify(tool === 'select'
        ? 'Drag a selection on the grid, then Copy and Paste to duplicate it.'
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
action('paste', () => placement.paste());
document.addEventListener('pointerdown', event => {
    if (!placement.active || event.button !== 0 || !event.isPrimary ||
        event.target.closest('#canvas-stage, #object-settings, #palette-menu, .zoom-bar, [data-tool], #copy, #paste, #undo, #redo')) return;
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
    if ((event.ctrlKey || event.metaKey) && ['c', 'v'].includes(key)) {
        event.preventDefault();
        finishStroke();
        if (key === 'c') placement.copy();
        else placement.paste();
    } else if (!(event.ctrlKey || event.metaKey)) placement.keydown(event);
});
function setZoom(value) {
    if (!project) return;
    finishPan();
    finishStroke();
    const workspace = $('workspace');
    const previous = canvas.getBoundingClientRect();
    const viewport = workspace.getBoundingClientRect();
    const centerX = (viewport.left + workspace.clientWidth / 2 - previous.left) / previous.width;
    const centerY = (viewport.top + workspace.clientHeight / 2 - previous.top) / previous.height;
    zoom = Math.max(1, Math.min(8, value));
    updateControls();
    render();
    const next = canvas.getBoundingClientRect();
    workspace.scrollLeft += next.left + centerX * next.width - viewport.left - workspace.clientWidth / 2;
    workspace.scrollTop += next.top + centerY * next.height - viewport.top - workspace.clientHeight / 2;
}
action('zoom-in', () => setZoom(zoom + 0.25));
action('zoom-out', () => setZoom(zoom - 0.25));
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
    $('grid-settings').hidden = !$('grid-settings').hidden;
    $('grid-toggle').setAttribute('aria-expanded', String(!$('grid-settings').hidden));
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
    $('crop-width').max = project.width - rect.x;
    $('crop-height').max = project.height - rect.y;
    $('crop-scale-label').hidden = ratioKey === 'free';
    if (ratioKey !== 'free') {
        const full = fitCrop(project.width, project.height, CROP_RATIOS[ratioKey]);
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
    $('crop-settings').hidden = true;
    $('crop-start').setAttribute('aria-expanded', 'false');
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
        rect: fitCrop(project.width, project.height, null), ratioKey: 'free',
        previousView: { zoom, x: workspace.scrollLeft, y: workspace.scrollTop },
    };
    zoom = 1;
    $('crop-ratio').value = 'free';
    $('crop-error').textContent = '';
    $('grid-settings').hidden = true;
    $('grid-toggle').setAttribute('aria-expanded', 'false');
    $('crop-settings').hidden = false;
    $('crop-start').setAttribute('aria-expanded', 'true');
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
        const rect = key === 'free' ? crop.rect : fitCrop(project.width, project.height, CROP_RATIOS[key]);
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
    const next = fitCrop(project.width, project.height, CROP_RATIOS[crop.ratioKey], Number($('crop-scale').value) / 100);
    crop.rect = moveCrop(next, old.x + old.width / 2 - next.x - next.width / 2,
        old.y + old.height / 2 - next.y - next.height / 2, project.width, project.height);
    renderCrop();
});
for (const dimension of ['width', 'height']) {
    $(`crop-${dimension}`).addEventListener('change', event => {
        if (!crop || crop.ratioKey !== 'free') return;
        const value = Math.floor(Number(event.target.value));
        const limit = dimension === 'width' ? project.width - crop.rect.x : project.height - crop.rect.y;
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
        ? resizeCrop(cropDrag.rect, cropDrag.corner, dx, dy, project.width, project.height, CROP_RATIOS[crop.ratioKey])
        : moveCrop(cropDrag.rect, dx, dy, project.width, project.height);
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
        ? resizeCrop(crop.rect, corner, dx, dy, project.width, project.height, ratio)
        : moveCrop(crop.rect, dx, dy, project.width, project.height);
    renderCrop();
});

function applyCrop() {
    if (!crop) return;
    endCropDrag();
    const rect = crop.rect;
    if (rect.x === 0 && rect.y === 0 && rect.width === project.width && rect.height === project.height) {
        exitCrop();
        notify('The crop already includes the entire image. No changes made.');
        return;
    }
    const output = document.createElement('canvas');
    output.width = rect.width;
    output.height = rect.height;
    output.getContext('2d').drawImage(reference, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const referenceData = output.toDataURL('image/png');
    const longest = Math.max(4, Math.min(MAX_SIDE, Math.round(Math.max(
        rect.width / project.width * project.cols, rect.height / project.height * project.rows))));
    const { cols, rows } = gridDimensions(rect.width, rect.height, longest);
    const cells = cropCells(project, rect, cols, rows);
    remember(snapshot());
    Object.assign(project, { width: rect.width, height: rect.height, cols, rows, cells, reference: referenceData });
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
$('name').addEventListener('input', () => {
    project.name = $('name').value.trim() || 'Untitled pattern';
    changed();
});
$('name').addEventListener('blur', () => { if (project) $('name').value = project.name; });
action('add-color', () => {
    const color = $('new-color').value.toLowerCase();
    addPaletteColor(color);
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

function download(blob, extension) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const filename = project.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'pattern';
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
    project.cells.forEach((color, index) => {
        if (color === null) return;
        const x = index % project.cols, y = Math.floor(index / project.cols);
        const left = Math.round(x * output.width / project.cols), top = Math.round(y * output.height / project.rows);
        const right = Math.round((x + 1) * output.width / project.cols), bottom = Math.round((y + 1) * output.height / project.rows);
        ctx.fillStyle = color;
        ctx.fillRect(left, top, right - left, bottom - top);
    });
    const blob = await new Promise(resolve => output.toBlob(resolve, `image/${format}`, 0.95));
    if (!blob || blob.type !== `image/${format}`) throw new Error(`This browser cannot export ${format.toUpperCase()}. Please choose PNG.`);
    download(blob, format === 'jpeg' ? 'jpg' : format);
    notify(`Exported ${output.width} x ${output.height}px ${format.toUpperCase()} without reference or gridlines.`);
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
