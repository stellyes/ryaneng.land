import { MAX_SIDE, gridDimensions, resizeCells, flood, line, validateProject, openStore } from './model.js';

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
let cursor = { x: 0, y: 0 };
let keyboardFocus = false;
let timer;
let dirty = false;
let revision = 0;
let saveQueue = Promise.resolve();
let store = null;
let storageError = null;
let zoom = 1;

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
    $(id).addEventListener('click', () => Promise.resolve().then(finishStroke).then(handler).catch(report));
}

const storeReady = openStore().then(value => { store = value; }).catch(error => {
    storageError = error;
    $('save-state').textContent = 'Browser saving unavailable';
    report(new Error('Browser storage is unavailable. Use Download project to keep your work. ' + error.message));
});

function snapshot() {
    return { cols: project.cols, rows: project.rows, cells: project.cells.slice() };
}

function remember(before) {
    history.push(before);
    // Bound undo memory even for 500 x 500 grids.
    while (history.length > 1 && history.reduce((sum, item) => sum + item.cells.length, 0) > 2000000) history.shift();
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
    finishStroke();
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
    for (const id of ['name', 'backup', 'export', 'grid-toggle', 'reference-toggle', 'lines-toggle']) $(id).disabled = !active;
    document.querySelectorAll('[data-tool]').forEach(button => { button.disabled = !active; });
    $('undo').disabled = !active || !history.length;
    $('redo').disabled = !active || !future.length;
    $('save-now').disabled = !active;
    $('zoom-out').disabled = !active || zoom <= 1;
    $('zoom-in').disabled = !active || zoom >= 8;
    if (active) {
        $('dimensions').textContent = `${project.cols} x ${project.rows} cells | Reference ${project.width} x ${project.height}px`;
        $('grid-size').value = Math.max(project.cols, project.rows);
        $('grid-value').value = $('grid-size').value;
    }
}

function renderPalette() {
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
        });
        $('palette').append(button);
    }
    $('selected-color').textContent = selected ? `Selected: ${selected}` : 'Add a color or sample your reference to start.';
    $('add-color').disabled = !project;
    $('new-color').disabled = !project;
}

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
    if (tool === 'sample' || $('reference-toggle').checked) {
        context.globalAlpha = tool === 'sample' ? 1 : 0.6;
        context.drawImage(reference, 0, 0, project.width, project.height);
        context.globalAlpha = 1;
    }
    const cellWidth = project.width / project.cols, cellHeight = project.height / project.rows;
    if (tool !== 'sample') project.cells.forEach((color, index) => {
        if (color === null) return;
        context.fillStyle = color;
        context.fillRect(index % project.cols * cellWidth, Math.floor(index / project.cols) * cellHeight, cellWidth, cellHeight);
    });
    if (tool !== 'sample' && $('lines-toggle').checked) {
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
    if (keyboardFocus) {
        context.strokeStyle = '#ffffff';
        context.lineWidth = 3 * project.width / canvas.width;
        context.strokeRect(cursor.x * cellWidth, cursor.y * cellHeight, cellWidth, cellHeight);
        context.strokeStyle = '#202020';
        context.lineWidth = project.width / canvas.width;
        context.strokeRect(cursor.x * cellWidth, cursor.y * cellHeight, cellWidth, cellHeight);
    }
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
    sampleCanvas.width = data.width;
    sampleCanvas.height = data.height;
    // Sample the full-opacity reference, with transparency displayed over white.
    sampleContext.fillStyle = '#ffffff';
    sampleContext.fillRect(0, 0, data.width, data.height);
    sampleContext.drawImage(image, 0, 0);
    selected = data.palette[0] || null;
    tool = 'paint';
    canvas.classList.remove('sampling');
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
    if ((tool === 'paint' || tool === 'fill') && !selected) {
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
    const color = tool === 'erase' || tool === 'erase-fill' ? null : selected;
    if (tool === 'fill' || tool === 'erase-fill') {
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
    if (!project || !largeScreen.matches || event.button !== 0 || stroke || !event.isPrimary) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    keyboardFocus = false;
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
    const position = cellAt(event);
    cursor = position;
    stroke = { id: event.pointerId, before: snapshot(), last: position, changed: false };
    canvas.setPointerCapture(event.pointerId);
    stroke.changed = applyCell(position.x, position.y);
    render();
});
canvas.addEventListener('pointermove', event => {
    if (project && largeScreen.matches && tool === 'sample') {
        previewSample(event);
        return;
    }
    if (!stroke || stroke.id !== event.pointerId || tool === 'fill' || tool === 'erase-fill') return;
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
canvas.addEventListener('keydown', event => {
    if (!project || !largeScreen.matches) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
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
        const before = snapshot();
        if (applyCell(cursor.x, cursor.y)) { remember(before); changed(); render(); }
    }
});

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
    finishStroke();
    tool = button.dataset.tool;
    canvas.classList.toggle('sampling', tool === 'sample');
    document.querySelectorAll('[data-tool]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    render();
    if (tool === 'sample') notify('Hover over the reference to preview a color. Click or tap to add it to your palette. Choose Paint when ready.');
}));

function undo() {
    finishStroke();
    if (!history.length) return;
    future.push(snapshot());
    Object.assign(project, history.pop());
    cursor = { x: 0, y: 0 };
    changed(); render();
}

function redo() {
    finishStroke();
    if (!future.length) return;
    history.push(snapshot());
    Object.assign(project, future.pop());
    cursor = { x: 0, y: 0 };
    changed(); render();
}

action('undo', undo);
action('redo', redo);
function setZoom(value) {
    if (!project) return;
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
        !project || !largeScreen.matches || document.querySelector('dialog[open]')) return;
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
$('grid-size').addEventListener('input', () => { $('grid-value').value = $('grid-size').value; });
action('apply-grid', () => {
    const { cols, rows } = gridDimensions(project.width, project.height, Number($('grid-size').value));
    if (cols === project.cols && rows === project.rows) return;
    remember(snapshot());
    project.cells = resizeCells(project.cells, project.cols, project.rows, cols, rows);
    project.cols = cols;
    project.rows = rows;
    cursor = { x: 0, y: 0 };
    changed(); render();
    notify('Grid resized. Existing paint was resampled; Undo restores the previous grid.');
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
    if (!largeScreen.matches) document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    else render();
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { finishStroke(); save().catch(report); }
});
window.addEventListener('beforeunload', event => {
    finishStroke();
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
});
renderPalette();
updateControls();
