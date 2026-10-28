import { BLEND_MODES, LOCKS, activeLayer, newLayer, bindLayer, layerOrder, layerAncestors, layerRoom,
    selectedLayers, selectedPixels, editLayerSelection, alignmentPlan, alignLayers, layerPixels, layerBounds } from './layers.js';

const $ = id => document.getElementById(id);
const paths = {
    transparency: '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/><path d="M3 3h6v6H3zm12 0h6v6h-6zM9 9h6v6H9zM3 15h6v6H3zm12 0h6v6h-6z" fill="currentColor"/>',
    color: '<path d="m14 4 6 6M4 20l2-7L17 2l5 5L11 18zM4 20l7-2"/>',
    position: '<path d="M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4"/>',
    all: '<rect x="4" y="10" width="16" height="12"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};
const labels = { transparency: 'Lock transparency', color: 'Lock painted colors', position: 'Lock position', all: 'Lock all' };
function icon(key) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = paths[key];
    return node;
}

export function createLayerPanel({ getProject, beforeEdit, remember, snapshot, changed, redraw, select, notify }) {
    let rendering = false;
    let drag = null;
    let suppressRowClick = false;
    let scrollTimer = null;
    let warningTimer = null;
    let pendingAlignment = null;
    const list = $('layer-list');
    const dropActions = { 'layer-delete': 'delete', 'layer-new': 'copy', 'layer-new-folder': 'folder' };
    $('layer-new').title = 'New blank layer; drop selected layers or folders here to duplicate them';
    $('layer-new-folder').title = 'New folder; groups multiple selected items, or drop selected items here to group them';
    $('layer-delete').title = 'Delete selected items; drop selected layers or folders here to delete them';
    $('layer-blend').append(...BLEND_MODES.map(mode => new Option(mode, mode)));
    $('layer-zoom-options').append(document.querySelector('.zoom-bar'));
    const alignments = [
        ['left', 'Align left edges', 'M4 3v18M7 6h12v5H7zM7 14h8v5H7z'],
        ['center-x', 'Align vertical centers', 'M12 2v20M5 5h14v5H5zM8 14h8v5H8z'],
        ['right', 'Align right edges', 'M20 3v18M5 6h12v5H5zM9 14h8v5H9z'],
        ['top', 'Align top edges', 'M3 4h18M5 7h5v12H5zM14 7h5v8h-5z'],
        ['center-y', 'Align horizontal centers', 'M2 12h20M5 5h5v14H5zM14 8h5v8h-5z'],
        ['bottom', 'Align bottom edges', 'M3 20h18M5 5h5v12H5zM14 9h5v8h-5z'],
    ];
    function alignmentWarning(message) {
        notify(message, true);
        const warning = $('layer-warning');
        warning.textContent = message;
        warning.hidden = false;
        clearTimeout(warningTimer);
        warningTimer = setTimeout(() => { warning.hidden = true; }, 3500);
    }
    function applyAlignment(project, mode, approve = false) {
        const changed = alignLayers(project, mode, approve);
        $('layer-warning').hidden = true;
        notify(changed ? 'Selected layers aligned. Undo restores their positions.' : 'Selected layers are already aligned.');
        return changed;
    }
    for (const [mode, label, path] of alignments) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.align = mode;
        button.title = button.ariaLabel = `${label} to the bottom-most selected layer`;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.innerHTML = `<path d="${path}"/>`;
        button.append(svg);
        button.addEventListener('click', () => {
            try {
                if (beforeEdit() === false) return;
                const plan = alignmentPlan(getProject(), mode);
                if (plan.needsApproval) {
                    pendingAlignment = mode;
                    $('alignment-dialog').showModal();
                    $('alignment-cancel').focus();
                } else edit(project => applyAlignment(project, mode));
            } catch (error) { alignmentWarning(error.message); }
        });
        $('layer-align').append(button);
    }
    $('alignment-cancel').addEventListener('click', () => $('alignment-dialog').close());
    $('alignment-dialog').addEventListener('close', () => { pendingAlignment = null; });
    $('alignment-approve').addEventListener('click', () => {
        const mode = pendingAlignment;
        $('alignment-dialog').close();
        if (mode) edit(project => applyAlignment(project, mode, true));
    });
    for (const key of LOCKS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.lock = key;
        button.title = button.ariaLabel = labels[key];
        button.append(icon(key));
        button.addEventListener('click', () => edit(project => {
            const layers = selectedPixels(project);
            if (!layers.length) return false;
            if (key !== 'all' && layers.some(layer => layer.locks.all)) throw new Error('Unlock all selected layers before changing individual locks.');
            const value = !layers.every(layer => layer.locks[key]);
            layers.forEach(layer => { layer.locks[key] = value; });
        }, false));
        $('layer-locks').append(button);
    }

    function edit(operation, selecting = true) {
        try {
            const project = getProject();
            if (!project) return;
            if (beforeEdit() === false) { render(); return; }
            const before = snapshot();
            if (operation(project) === false) return;
            bindLayer(project);
            remember(before);
            changed();
            redraw();
            if (selecting || activeLayer(project)?.type === 'layer') select();
        } catch (error) { notify(error.message, true); }
    }

    function selectItem(item, toggle = false) {
        if (beforeEdit() === false) { render(); return; }
        const project = getProject();
        const ids = new Set(project.selectedLayerIds);
        if (toggle && ids.has(item.id) && ids.size > 1) {
            ids.delete(item.id);
            if (project.activeLayerId === item.id) project.activeLayerId = [...ids].at(-1);
        } else {
            if (!toggle) ids.clear();
            ids.add(item.id);
            project.activeLayerId = item.id;
        }
        project.selectedLayerIds = [...ids];
        bindLayer(project);
        changed();
        select();
        render();
    }

    function nudge(project, delta) {
        return editLayerSelection(project, delta < 0 ? 'up' : 'down');
    }

    function clearDrop() {
        Object.keys(dropActions).forEach(id => $(id).classList.remove('layer-drop-target'));
        list.querySelectorAll('.drop-before,.drop-after,.drop-folder').forEach(row =>
            row.classList.remove('drop-before', 'drop-after', 'drop-folder'));
        list.classList.remove('drop-end');
    }

    function dropAt(x, y) {
        clearDrop();
        const hit = document.elementFromPoint(x, y);
        const actionButton = hit?.closest('.layer-footer button');
        if (actionButton && dropActions[actionButton.id]) {
            actionButton.classList.add('layer-drop-target');
            return { action: dropActions[actionButton.id] };
        }
        const bounds = list.getBoundingClientRect();
        if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
        const project = getProject(), source = project.layers.find(item => item.id === drag.id);
        if (!source) return null;
        let row = hit?.closest('.layer-item');
        if (!row || !list.contains(row)) {
            list.classList.add('drop-end');
            return { target: null, position: 'after', parentId: null };
        }
        let target = project.layers.find(item => item.id === row.dataset.layerId);
        const sources = selectedLayers(project, true);
        if (!target || sources.some(layer => layer === target || layerAncestors(project, target).includes(layer))) return null;
        const rect = row.getBoundingClientRect(), fraction = (y - rect.top) / rect.height;
        if (target.type === 'folder' && fraction >= 0.25 && fraction <= 0.75) {
            row.classList.add('drop-folder', 'drop-after');
            return { target: target.id, position: 'inside', parentId: target.id };
        }
        let parentId = target.parentId;
        const position = fraction < 0.5 ? 'before' : 'after';
        if (parentId && x < rect.left + 20) {
            if (parentId) {
                target = project.layers.find(item => item.id === parentId);
                row = [...list.children].find(item => item.dataset.layerId === target.id);
            }
            parentId = target.parentId;
        }
        // After a folder means after its entire group, not between the header and its children.
        if (target.type === 'folder' && position === 'after' && target.expanded) {
            row = [...list.children].filter(item => {
                const layer = project.layers.find(layer => layer.id === item.dataset.layerId);
                return layer && layerAncestors(project, layer).includes(target);
            }).pop() || row;
        }
        row.classList.add(`drop-${position}`);
        return { target: target.id, position, parentId };
    }

    function endDrag(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (event.type === 'pointerup' && drag.active) drag.drop = dropAt(event.clientX, event.clientY);
        const finished = drag;
        drag = null;
        clearInterval(scrollTimer);
        scrollTimer = null;
        clearDrop();
        list.classList.remove('drag-active');
        list.querySelectorAll('.dragging').forEach(row => row.classList.remove('dragging'));
        if (list.hasPointerCapture(finished.pointerId)) list.releasePointerCapture(finished.pointerId);
        if (event.type === 'pointerup') {
            suppressRowClick = finished.active || finished.background;
            if (!finished.active && finished.background) {
                const layer = getProject()?.layers.find(item => item.id === finished.id);
                if (layer) selectItem(layer, finished.toggle);
            }
        }
        if (event.type === 'pointerup' && finished.active && finished.drop) {
            const drop = finished.drop;
            edit(project => {
                if (drop.action) {
                    return editLayerSelection(project, drop.action);
                }
                return editLayerSelection(project, 'move', drop);
            });
        }
    }

    list.addEventListener('pointerdown', event => {
        suppressRowClick = false;
        const row = event.target.closest('.layer-item');
        const control = event.target.closest('button,input,select,textarea,a');
        if (row && (event.ctrlKey || event.metaKey) && control?.matches('input,.layer-select') && event.button === 0) {
            event.preventDefault();
            selectItem(getProject().layers.find(layer => layer.id === row.dataset.layerId), true);
            suppressRowClick = true;
            return;
        }
        if (!row || (control && !control.classList.contains('layer-drag')) || event.button !== 0 || !event.isPrimary) return;
        const handle = row.querySelector('.layer-drag');
        if (handle.disabled) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        drag = { id: row.dataset.layerId, pointerId: event.pointerId, background: true, toggle: event.ctrlKey || event.metaKey,
            startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, drop: null };
        list.setPointerCapture(event.pointerId);
    });
    list.addEventListener('click', event => {
        if (!suppressRowClick || event.detail === 0) return;
        suppressRowClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
    list.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.x = event.clientX; drag.y = event.clientY;
        if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
        event.preventDefault();
        if (!drag.active) {
            const project = getProject();
            if (!project.selectedLayerIds.includes(drag.id)) {
                if (beforeEdit() === false) { endDrag({ type: 'pointercancel', pointerId: drag.pointerId }); return; }
                project.selectedLayerIds = [drag.id];
                project.activeLayerId = drag.id;
                bindLayer(project);
                changed();
            }
            drag.active = true;
            list.classList.add('drag-active');
            [...list.children].filter(row => project.selectedLayerIds.includes(row.dataset.layerId)).forEach(row => row.classList.add('dragging'));
            scrollTimer = setInterval(() => {
                if (!drag) return;
                const bounds = list.getBoundingClientRect();
                if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) return;
                const direction = drag.y < bounds.top + 24 ? -1 : drag.y > bounds.bottom - 24 ? 1 : 0;
                if (direction) {
                    list.scrollTop += direction * 12;
                    drag.drop = dropAt(drag.x, drag.y);
                }
            }, 50);
        }
        drag.drop = dropAt(drag.x, drag.y);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) list.addEventListener(type, endDrag);
    window.addEventListener('blur', () => { if (drag) endDrag({ type: 'pointercancel', pointerId: drag.pointerId }); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drag) {
            event.preventDefault();
            endDrag({ type: 'pointercancel', pointerId: drag.pointerId });
        }
    });
    list.addEventListener('keydown', event => {
        const handle = event.target.closest('.layer-drag');
        if (!handle || handle.disabled || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const id = handle.closest('.layer-item').dataset.layerId;
        edit(project => {
            if (!project.selectedLayerIds.includes(id)) {
                project.selectedLayerIds = [id];
                project.activeLayerId = id;
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') return nudge(project, event.key === 'ArrowUp' ? -1 : 1);
            const layer = project.layers.find(item => item.id === id);
            const siblings = layerOrder(project).filter(item => item.parentId === layer.parentId);
            const index = siblings.indexOf(layer);
            let target, position, parentId = layer.parentId;
            if (event.key === 'ArrowLeft') {
                if (!layer.parentId) { notify('This layer is already outside a folder.', true); return false; }
                target = layer.parentId; position = 'after';
                parentId = project.layers.find(item => item.id === target).parentId;
            } else if (event.key === 'ArrowRight') {
                const folder = siblings.slice(0, index).reverse().find(item => item.type === 'folder');
                if (!folder) { notify('Place a layer or folder below a folder, then press Right to group it.', true); return false; }
                target = folder.id; position = 'inside'; parentId = folder.id;
            }
            return editLayerSelection(project, 'move', { target, position, parentId });
        });
        [...list.children].find(row => row.dataset.layerId === id)?.querySelector('.layer-drag').focus({ preventScroll: true });
    });

    function preview(layer, cols, rows) {
        const canvas = document.createElement('canvas');
        canvas.className = 'layer-thumbnail';
        canvas.width = canvas.height = 48;
        const output = canvas.getContext('2d');
        if (!layer.offCanvas?.length) {
            const source = document.createElement('canvas');
            source.width = cols; source.height = rows;
            const context = source.getContext('2d'), pixels = context.createImageData(cols, rows);
            layer.cells.forEach((color, i) => {
                if (color === null) return;
                for (let c = 0; c < 3; c++) pixels.data[i * 4 + c] = parseInt(color.slice(1 + c * 2, 3 + c * 2), 16);
                pixels.data[i * 4 + 3] = 255;
            });
            context.putImageData(pixels, 0, 0);
            const scale = 48 / Math.max(cols, rows);
            output.imageSmoothingEnabled = false;
            output.drawImage(source, (48 - cols * scale) / 2, (48 - rows * scale) / 2, cols * scale, rows * scale);
            return canvas;
        }
        const bounds = layer.offCanvas?.length ? layerBounds({ cols, rows }, layer) : { x: 0, y: 0, width: cols, height: rows };
        const scale = 48 / Math.max(bounds.width, bounds.height);
        for (const [x, y, color] of layerPixels({ cols, rows }, layer)) {
            output.fillStyle = color;
            output.fillRect((48 - bounds.width * scale) / 2 + (x - bounds.x) * scale,
                (48 - bounds.height * scale) / 2 + (y - bounds.y) * scale, Math.max(1, scale), Math.max(1, scale));
        }
        return canvas;
    }

    function render() {
        if (rendering) return;
        rendering = true;
        try {
            const project = getProject();
            if (!project) { $('layer-list').replaceChildren(); return; }
            bindLayer(project);
            const current = activeLayer(project), isLayer = current?.type === 'layer';
            const pixels = selectedPixels(project), settings = isLayer ? current : pixels[0];
            const locked = pixels.some(layer => layer.locks.all);
            const focus = document.activeElement;
            const focusedId = focus?.dataset.layerName;
            const caret = focusedId ? focus.selectionStart : null;
            const draftName = focusedId ? focus.value : null;
            $('layer-blend').disabled = !pixels.length || locked;
            $('layer-blend').value = settings?.blendMode || 'Normal';
            $('layer-blend').title = pixels.some(layer => layer.blendMode !== settings?.blendMode) ? 'Mixed blend modes; choose a mode to apply to all selected layers' : 'Blend mode for selected layers';
            const opacity = Math.round((settings?.opacity ?? 1) * 100);
            for (const id of ['layer-opacity', 'layer-opacity-range']) {
                $(id).disabled = !pixels.length || locked;
                $(id).value = opacity;
                $(id).title = pixels.some(layer => layer.opacity !== settings?.opacity) ? 'Mixed opacity; change to apply to all selected layers' : 'Opacity for selected layers';
            }
            for (const button of $('layer-locks').querySelectorAll('button')) {
                button.disabled = !pixels.length || (locked && button.dataset.lock !== 'all');
                const count = pixels.filter(layer => layer.locks[button.dataset.lock]).length;
                button.setAttribute('aria-pressed', count > 0 && count < pixels.length ? 'mixed' : String(count > 0));
            }
            const list = $('layer-list');
            const scrollTop = list.scrollTop;
            list.replaceChildren();
            for (const layer of layerOrder(project)) {
                const ancestors = layerAncestors(project, layer);
                if (ancestors.some(folder => !folder.expanded)) continue;
                const row = document.createElement('div');
                row.className = 'layer-item';
                row.dataset.layerId = layer.id;
                row.classList.toggle('selected', project.selectedLayerIds.includes(layer.id));
                row.classList.toggle('active-layer', current === layer);
                row.setAttribute('aria-selected', String(project.selectedLayerIds.includes(layer.id)));
                row.setAttribute('role', 'option');
                row.classList.toggle('nested', Boolean(layer.parentId));
                row.style.marginLeft = `${ancestors.length * 14}px`;
                const handle = document.createElement('button');
                handle.type = 'button';
                handle.className = 'layer-drag';
                handle.textContent = '\u283f';
                handle.ariaLabel = `Drag ${layer.name}`;
                handle.title = 'Ctrl/Cmd-click to select multiple items. Drag to reorder; drop on a folder to group. Arrow keys move selected items.';
                handle.disabled = layer.type === 'layer' && layer.locks.all;
                row.append(handle);
                const visibility = document.createElement('button');
                visibility.type = 'button';
                visibility.title = visibility.ariaLabel = `${layer.visible ? 'Hide' : 'Show'} ${layer.name}`;
                visibility.setAttribute('aria-pressed', String(layer.visible));
                visibility.className = 'layer-eye';
                visibility.append(icon('eye'));
                visibility.addEventListener('click', () => edit(() => { layer.visible = !layer.visible; }, false));
                const choose = document.createElement('button');
                choose.type = 'button';
                choose.className = 'layer-select';
                choose.ariaLabel = `Select ${layer.name}`;
                choose.setAttribute('aria-pressed', String(project.selectedLayerIds.includes(layer.id)));
                choose.textContent = layer.type === 'folder' ? layer.expanded ? '\u25be' : '\u25b8' : '';
                if (layer.type === 'layer') choose.append(preview(layer, project.cols, project.rows));
                choose.addEventListener('click', event => {
                    if (event.ctrlKey || event.metaKey) { selectItem(layer, true); return; }
                    if (layer.type === 'folder') edit(() => {
                        layer.expanded = !layer.expanded;
                        project.activeLayerId = layer.id;
                        project.selectedLayerIds = [layer.id];
                    });
                    else selectItem(layer);
                });
                const name = document.createElement('input');
                name.value = layer.id === focusedId ? draftName : layer.name;
                name.maxLength = 80;
                name.dataset.layerName = layer.id;
                name.ariaLabel = `Rename ${layer.type} ${layer.name}`;
                name.addEventListener('focus', () => { if (!rendering && activeLayer(getProject())?.id !== layer.id) selectItem(layer); });
                name.addEventListener('change', () => {
                    const value = name.value.trim();
                    if (!value) { name.value = layer.name; notify('Layer names cannot be empty.', true); return; }
                    if (value !== layer.name) edit(() => { layer.name = value; }, false);
                });
                name.addEventListener('keydown', event => {
                    if (event.key === 'Enter') { event.preventDefault(); name.blur(); }
                    if (event.key === 'Escape') { name.value = layer.name; name.blur(); }
                });
                row.append(visibility, name);
                if (layer.type === 'layer') {
                    const badges = document.createElement('span');
                    badges.className = 'layer-badges';
                    for (const key of layer.locks.all ? ['all'] : LOCKS.filter(key => layer.locks[key])) {
                        const badge = document.createElement('span');
                        badge.title = badge.ariaLabel = labels[key];
                        badge.append(icon(key));
                        badges.append(badge);
                    }
                    row.append(badges);
                }
                row.append(choose);
                row.addEventListener('click', event => {
                    if (!event.target.closest('button,input')) selectItem(layer, event.ctrlKey || event.metaKey);
                });
                list.append(row);
            }
            list.scrollTop = scrollTop;
            const roots = selectedLayers(project, true);
            for (const [id, delta] of [['layer-up', -1], ['layer-down', 1]]) {
                $(id).disabled = locked || !roots.some(layer => {
                    const siblings = layerOrder(project).filter(item => item.parentId === layer.parentId);
                    const neighbor = siblings[siblings.indexOf(layer) + delta];
                    return neighbor && !project.selectedLayerIds.includes(neighbor.id);
                });
            }
            $('layer-delete').disabled = locked;
            if (focusedId) {
                const input = [...list.querySelectorAll('input')].find(input => input.dataset.layerName === focusedId);
                if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(caret, caret); }
            }
        } finally { rendering = false; }
    }

    $('layer-blend').addEventListener('change', () => {
        const mode = $('layer-blend').value;
        edit(project => {
            const layers = selectedPixels(project);
            if (layers.some(layer => layer.locks.all)) throw new Error('Unlock all selected layers before changing blend modes.');
            layers.forEach(layer => { layer.blendMode = mode; });
            notify(`${mode} blend mode applied.`);
        }, false);
    });
    $('layer-opacity-range').addEventListener('input', () => { $('layer-opacity').value = $('layer-opacity-range').value; });
    for (const id of ['layer-opacity', 'layer-opacity-range']) $(id).addEventListener('change', () => {
        const value = Number($(id).value);
        if (!$(id).value.trim() || !Number.isInteger(value) || value < 0 || value > 100) {
            notify('Layer opacity must be a whole percentage from 0 to 100.', true);
            render();
            return;
        }
        edit(project => {
            const layers = selectedPixels(project);
            if (layers.some(layer => layer.locks.all)) throw new Error('Unlock all selected layers before changing opacity.');
            layers.forEach(layer => { layer.opacity = value / 100; });
        }, false);
    });
    for (const [id, delta] of [['layer-up', -1], ['layer-down', 1]]) {
        $(id).addEventListener('click', () => edit(project => {
            return nudge(project, delta);
        }));
    }
    $('layer-new').addEventListener('click', () => edit(project => {
        layerRoom(project, true);
        const current = activeLayer(project);
        const layer = newLayer(project.cols, project.rows, `Layer ${project.layers.filter(item => item.type === 'layer').length + 1}`);
        layer.parentId = current.type === 'folder' ? current.id : current.parentId;
        const parent = project.layers.find(item => item.id === layer.parentId);
        if (parent) parent.expanded = true;
        project.layers.splice(Math.max(0, project.layers.indexOf(current)), 0, layer);
        project.activeLayerId = layer.id;
        project.selectedLayerIds = [layer.id];
    }));
    $('layer-new-folder').addEventListener('click', () => edit(project => {
        if (project.selectedLayerIds.length > 1) return editLayerSelection(project, 'folder');
        layerRoom(project, false);
        const folder = { id: crypto.randomUUID(), type: 'folder', name: 'New folder', parentId: null, visible: true, expanded: true };
        project.layers.unshift(folder);
        project.activeLayerId = folder.id;
        project.selectedLayerIds = [folder.id];
    }));
    $('layer-delete').addEventListener('click', () => edit(project => {
        editLayerSelection(project, 'delete');
    }));
    $('layer-zoom').addEventListener('click', () => {
        const panel = $('layer-zoom-options');
        panel.hidden = !panel.hidden;
        $('layer-zoom').setAttribute('aria-expanded', String(!panel.hidden));
    });
    return { render };
}
