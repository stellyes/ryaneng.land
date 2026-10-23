import { boxFromCells, copyCells, objectCorners, rasterObject, resizeObject, rotatePoint } from './objects.js';

export function createPlacementEditor({ canvas, getProject, getColor, getStroke, commitPixels, redraw, updateControls, notify }) {
    const $ = id => document.getElementById(id);
    const overlay = $('object-overlay');
    let object = null;
    let drag = null;
    let clipboard = null;
    let pixels = null;

    function refresh() {
        if (object?.kind === 'selection') {
            const project = getProject();
            object.width = Math.max(1, Math.min(project.cols, object.width));
            object.height = Math.max(1, Math.min(project.rows, object.height));
            const x = Math.max(0, Math.min(project.cols - object.width, Math.round(object.cx - object.width / 2)));
            const y = Math.max(0, Math.min(project.rows - object.height, Math.round(object.cy - object.height / 2)));
            object.cx = x + object.width / 2;
            object.cy = y + object.height / 2;
        }
        pixels = null;
        updateControls();
        redraw();
    }

    function pointAt(event) {
        const rect = canvas.getBoundingClientRect(), project = getProject();
        return { x: (event.clientX - rect.left) / rect.width * project.cols, y: (event.clientY - rect.top) / rect.height * project.rows };
    }

    function cellAt(point) {
        const project = getProject();
        return { x: Math.max(0, Math.min(project.cols - 1, Math.floor(point.x))), y: Math.max(0, Math.min(project.rows - 1, Math.floor(point.y))) };
    }

    function releaseDrag() {
        if (!drag) return;
        const finished = drag;
        drag = null;
        if (finished.target.hasPointerCapture(finished.id)) finished.target.releasePointerCapture(finished.id);
    }

    function preview() {
        if (!object) return new Map();
        const project = getProject();
        if (!pixels) pixels = rasterObject(object, project.cols, project.rows, getColor());
        return pixels;
    }

    function commit() {
        if (!object) return;
        releaseDrag();
        const pending = preview();
        object = null;
        commitPixels(pending);
        refresh();
    }

    function cancel() {
        releaseDrag();
        object = null;
        refresh();
        notify('Selection or placement cancelled. The pattern is unchanged.');
    }

    function begin(event, tool) {
        if (object) {
            commit();
            notify('Placement finalized. Drag again to start another.');
            return true;
        }
        if (!['line', 'shape', 'select'].includes(tool)) return false;
        const point = pointAt(event), cell = cellAt(point);
        object = tool === 'line'
            ? { kind: 'line', a: cell, b: cell, stroke: getStroke('line') }
            : { kind: tool === 'select' ? 'selection' : 'shape', ...boxFromCells(cell, cell),
                shape: $('shape-type').value, filled: $('shape-fill').value === 'filled', stroke: getStroke('shape') };
        drag = { id: event.pointerId, target: canvas, mode: 'draw', start: cell, before: null };
        canvas.setPointerCapture(event.pointerId);
        refresh();
        notify(tool === 'select' ? 'Drag to select cells, then Copy or Cut and Paste. The border shows the selected dimensions.' :
            'Adjust the handles or palette color. Click away or Apply to place; Escape cancels.');
        return true;
    }

    function move(event) {
        if (!drag || drag.id !== event.pointerId) return;
        event.preventDefault();
        const point = pointAt(event), before = drag.before;
        if (drag.mode === 'draw') {
            const end = cellAt(point);
            if (object.kind === 'line') object.b = end;
            else Object.assign(object, boxFromCells(drag.start, end));
        } else if (drag.mode === 'a' || drag.mode === 'b') {
            object[drag.mode] = cellAt(point);
        } else if (drag.mode === 'rotate') {
            const angle = Math.atan2(point.y - before.cy, point.x - before.cx) * 180 / Math.PI;
            object.angle = ((Math.round(before.angle + angle - drag.angle) % 360) + 360) % 360;
        } else if (drag.mode === 'resize') {
            object = resizeObject(before, drag.corner, point);
        } else {
            const dx = Math.round(point.x - drag.start.x), dy = Math.round(point.y - drag.start.y);
            if (object.kind === 'line') {
                const project = getProject();
                const boundedX = Math.max(-Math.min(before.a.x, before.b.x), Math.min(project.cols - 1 - Math.max(before.a.x, before.b.x), dx));
                const boundedY = Math.max(-Math.min(before.a.y, before.b.y), Math.min(project.rows - 1 - Math.max(before.a.y, before.b.y), dy));
                object.a = { x: before.a.x + boundedX, y: before.a.y + boundedY };
                object.b = { x: before.b.x + boundedX, y: before.b.y + boundedY };
            } else {
                const project = getProject();
                const minX = object.kind === 'selection' ? before.width / 2 : 0;
                const minY = object.kind === 'selection' ? before.height / 2 : 0;
                object.cx = Math.max(minX, Math.min(project.cols - minX, before.cx + dx));
                object.cy = Math.max(minY, Math.min(project.rows - minY, before.cy + dy));
            }
        }
        refresh();
    }

    function end(event) {
        if (!drag || drag.id !== event.pointerId) return;
        if (event.type === 'pointerup') move(event);
        if (event.type === 'pointercancel' || event.type === 'lostpointercapture') object = drag.before;
        releaseDrag();
        refresh();
    }

    overlay.addEventListener('pointerdown', event => {
        if (!object || drag || event.button !== 0 || !event.isPrimary) return;
        const handle = event.target.closest('[data-edit]');
        if (!handle) return;
        event.preventDefault();
        event.stopPropagation();
        // Keep focus off SVG geometry: native SVG focus rings can scale with the grid.
        (handle instanceof SVGElement ? canvas : handle).focus({ preventScroll: true });
        const point = pointAt(event);
        drag = { id: event.pointerId, target: overlay, mode: handle.dataset.edit, corner: handle.dataset.resize,
            start: point, before: structuredClone(object), angle: Math.atan2(point.y - object.cy, point.x - object.cx) * 180 / Math.PI };
        overlay.setPointerCapture(event.pointerId);
    });
    for (const element of [canvas, overlay]) {
        element.addEventListener('pointermove', move);
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(name, end);
    }
    window.addEventListener('blur', () => {
        if (!drag) return;
        object = drag.before;
        releaseDrag();
        refresh();
    });

    function position(element, point) {
        const project = getProject();
        element.style.left = `${point.x / project.cols * 100}%`;
        element.style.top = `${point.y / project.rows * 100}%`;
    }

    function render() {
        overlay.hidden = !object;
        if (!object) return;
        const project = getProject(), isLine = object.kind === 'line';
        $('object-outline').setAttribute('viewBox', `0 0 ${project.cols} ${project.rows}`);
        $('line-hit').hidden = !isLine;
        $('box-hit').hidden = isLine;
        // SVG does not implement the HTML hidden attribute consistently.
        $('line-hit').style.display = isLine ? '' : 'none';
        $('box-hit').style.display = isLine ? 'none' : '';
        $('object-help').textContent = object.kind === 'selection'
            ? 'Copy or Cut the highlighted cells, then Paste. Drag the border or corners to adjust the selection.'
            : 'Drag handles to adjust; drag inside to move. Palette changes recolor lines/shapes. Click away or Apply to finalize; Escape or Delete cancels. Content outside the grid is clipped.';
        for (const button of overlay.querySelectorAll('button')) button.hidden = true;
        if (isLine) {
            const a = { x: object.a.x + 0.5, y: object.a.y + 0.5 }, b = { x: object.b.x + 0.5, y: object.b.y + 0.5 };
            for (const [key, point] of [['a', a], ['b', b]]) {
                const button = overlay.querySelector(`[data-edit="${key}"]`);
                button.hidden = false;
                position(button, point);
            }
            const hit = $('line-hit');
            for (const [key, value] of Object.entries({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })) hit.setAttribute(key, value);
            $('object-dimensions').textContent = `${Math.abs(object.a.x - object.b.x) + 1} x ${Math.abs(object.a.y - object.b.y) + 1} cells`;
            position($('object-dimensions'), a);
        } else {
            const corners = objectCorners(object);
            $('box-hit').setAttribute('points', corners.map(p => `${p.x},${p.y}`).join(' '));
            for (const [index, corner] of ['nw', 'ne', 'se', 'sw'].entries()) {
                const button = overlay.querySelector(`[data-resize="${corner}"]`);
                button.hidden = false;
                position(button, corners[index]);
            }
            $('object-dimensions').textContent = `${object.width} x ${object.height} cells`;
            position($('object-dimensions'), corners[0]);
            if (object.kind !== 'selection') {
                const button = overlay.querySelector('[data-edit="rotate"]');
                const offset = rotatePoint(0, -object.height / 2 - 28 * project.rows / canvas.getBoundingClientRect().height, object.angle);
                button.hidden = false;
                position(button, { x: object.cx + offset.x, y: object.cy + offset.y });
                for (const key of ['width', 'height', 'angle']) {
                    const input = $(`object-${key}`);
                    if (document.activeElement !== input) input.value = object[key];
                }
            }
        }
    }

    function clearSelection() {
        releaseDrag();
        const project = getProject();
        const x = Math.round(object.cx - object.width / 2), y = Math.round(object.cy - object.height / 2);
        const cleared = new Map();
        for (let row = 0; row < object.height; row++) for (let col = 0; col < object.width; col++) {
            cleared.set((y + row) * project.cols + x + col, null);
        }
        object = null;
        commitPixels(cleared);
        refresh();
    }

    function copy(cut = false) {
        if (object?.kind !== 'selection') {
            notify(`Choose Select and drag over a section of the grid before ${cut ? 'cutting' : 'copying'}.`, true);
            return;
        }
        releaseDrag();
        clipboard = copyCells(getProject(), object);
        if (cut) {
            clearSelection();
            notify(`Cut ${clipboard.width} x ${clipboard.height} cells. The original area is transparent. Paste to place the cut section; Undo restores the removal.`);
            return;
        }
        updateControls();
        notify(`Copied ${clipboard.width} x ${clipboard.height} cells. Paste to create an editable duplicate.`);
    }

    function paste() {
        if (!clipboard) {
            notify('Copy or Cut a grid selection before pasting.', true);
            return;
        }
        commit();
        const project = getProject(), rect = canvas.getBoundingClientRect(), workspace = $('workspace');
        const viewport = workspace.getBoundingClientRect();
        const cx = Math.max(0, Math.min(project.cols, Math.round((viewport.left + workspace.clientWidth / 2 - rect.left) / rect.width * project.cols - clipboard.width / 2) + clipboard.width / 2));
        const cy = Math.max(0, Math.min(project.rows, Math.round((viewport.top + workspace.clientHeight / 2 - rect.top) / rect.height * project.rows - clipboard.height / 2) + clipboard.height / 2));
        object = { kind: 'paste', cx, cy, width: clipboard.width, height: clipboard.height, angle: 0, source: clipboard };
        refresh();
        notify('Pasted a floating duplicate. Move, resize, or rotate it; click away or Apply to place. Empty copied cells are transparent.');
    }

    function keydown(event) {
        if (!object || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
        if (event.key === 'Delete' && object.kind === 'selection') {
            event.preventDefault();
            clearSelection();
            canvas.focus({ preventScroll: true });
            notify('Selected pixels deleted to transparency. Undo restores them. The clipboard is unchanged.');
            return true;
        }
        // Mac keyboards label Backspace "delete", so both discard a floating line, shape, or paste.
        if (event.key === 'Escape' || (object.kind !== 'selection' && (event.key === 'Delete' || event.key === 'Backspace'))) {
            event.preventDefault();
            cancel();
            return true;
        }
        if (event.key === 'Enter' && (event.target === canvas || event.target.closest('#object-overlay'))) {
            event.preventDefault();
            commit();
            canvas.focus({ preventScroll: true });
            return true;
        }
        const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!steps[event.key]) return false;
        const handle = event.target.closest('[data-edit]');
        if (event.target !== canvas && !handle) return false;
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1, [dx, dy] = steps[event.key].map(value => value * amount);
        const project = getProject();
        if (handle?.dataset.edit === 'rotate') object.angle = (object.angle + (dx || dy) + 360) % 360;
        else if (object.kind === 'line') {
            const keys = ['a', 'b'].includes(handle?.dataset.edit) ? [handle.dataset.edit] : ['a', 'b'];
            for (const key of keys) object[key] = {
                x: Math.max(0, Math.min(project.cols - 1, object[key].x + dx)),
                y: Math.max(0, Math.min(project.rows - 1, object[key].y + dy)),
            };
        } else if (handle?.dataset.resize) {
            const corner = ['nw', 'ne', 'se', 'sw'].indexOf(handle.dataset.resize);
            const point = objectCorners(object)[corner];
            object = resizeObject(object, handle.dataset.resize, { x: point.x + dx, y: point.y + dy });
        } else {
            const marginX = object.kind === 'selection' ? object.width / 2 : 0;
            const marginY = object.kind === 'selection' ? object.height / 2 : 0;
            object.cx = Math.max(marginX, Math.min(project.cols - marginX, object.cx + dx));
            object.cy = Math.max(marginY, Math.min(project.rows - marginY, object.cy + dy));
        }
        refresh();
        return true;
    }

    function startKeyboard(tool, cell) {
        object = tool === 'line' ? { kind: 'line', a: { ...cell }, b: { ...cell }, stroke: getStroke('line') } :
            { kind: tool === 'select' ? 'selection' : 'shape', ...boxFromCells(cell, cell),
                shape: $('shape-type').value, filled: $('shape-fill').value === 'filled', stroke: getStroke('shape') };
        refresh();
        overlay.querySelector(tool === 'line' ? '[data-edit="b"]' : '[data-resize="se"]').focus({ preventScroll: true });
        notify('Use arrow keys on the focused handle to adjust. Enter applies; Escape cancels.');
    }

    for (const key of ['width', 'height', 'angle']) $(`object-${key}`).addEventListener('change', event => {
        if (!object || object.kind === 'line' || object.kind === 'selection') return;
        const value = Number(event.target.value), min = key === 'angle' ? 0 : 1, max = key === 'angle' ? 359 : 500;
        if (!event.target.value.trim() || !Number.isInteger(value) || value < min || value > max) {
            notify(`${key} must be a whole number from ${min} to ${max}.`, true);
            event.target.value = object[key];
            return;
        }
        object[key] = value;
        refresh();
    });
    for (const id of ['shape-type', 'shape-fill']) $(id).addEventListener('change', () => {
        if (object?.kind === 'shape') {
            object.shape = $('shape-type').value;
            object.filled = $('shape-fill').value === 'filled';
            refresh();
        }
    });
    function setStroke(width) {
        if (object?.kind !== 'line' && object?.kind !== 'shape') return;
        object.stroke = width;
        refresh();
    }
    $('placement-apply').addEventListener('click', commit);
    $('placement-cancel').addEventListener('click', cancel);

    return {
        begin, commit, cancel, copy, cut: () => copy(true), paste, keydown, startKeyboard, refresh, render, preview, setStroke,
        get active() { return Boolean(object); },
        get kind() { return object?.kind; },
        get filled() { return Boolean(object?.filled); },
        get selecting() { return object?.kind === 'selection'; },
        get canPaste() { return Boolean(clipboard); },
        get dragging() { return Boolean(drag); },
    };
}
