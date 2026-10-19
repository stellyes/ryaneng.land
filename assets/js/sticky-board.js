(() => {
    'use strict';

    const CONFIG = {
        noteSize: 200,
        textLimit: 256,
        timeZone: 'America/Los_Angeles',
        worldLimit: 4000,
        worldPad: 120,
        holdDelay: 400,
        imageSize: 480,
        fallbackBack: '../code.html',
    };

    const PAPERS = [
        { id: 'yellow', color: '#f6e07a', label: 'Yellow' },
        { id: 'pink', color: '#f5a8c2', label: 'Pink' },
        { id: 'blue', color: '#a3d4ef', label: 'Blue' },
        { id: 'green', color: '#bfe3a0', label: 'Green' },
        { id: 'cream', color: '#f1daa8', label: 'Cream' },
    ];

    const INKS = [
        { color: '#2b2a22', label: 'Black' },
        { color: '#c0392b', label: 'Red' },
        { color: '#1f5fa8', label: 'Blue' },
        { color: '#2e7d32', label: 'Green' },
        { color: '#ffffff', label: 'White' },
    ];

    const N = CONFIG.noteSize;
    const ACTIVE_Z = 20000000;
    const GHOST_Z = 30000000;
    let clockOffset = 0;

    const $ = (id) => document.getElementById(id);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const pad2 = (n) => String(n).padStart(2, '0');
    const paperColor = (id) => (PAPERS.find((p) => p.id === id) || PAPERS[0]).color;
    const isSafeImage = (src) => {
        if (typeof src !== 'string') return false;
        if (/^data:image\/(png|jpeg|webp);base64,/.test(src)) return true;
        const mediaUrl = window.STICKY_BOARD_CONFIG && window.STICKY_BOARD_CONFIG.mediaUrl;
        return !!mediaUrl && src.startsWith(`${mediaUrl}/published/`) && !src.includes('..');
    };
    const normDeg = (d) => Math.round(((((d + 180) % 360) + 360) % 360 - 180) * 10) / 10;

    // ---- Board time (one shared timezone so everyone resets together) ----

    const dateFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: CONFIG.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });

    function boardDate(date = new Date(Date.now() + clockOffset)) {
        const p = {};
        for (const part of dateFmt.formatToParts(date)) p[part.type] = part.value;
        return { y: +p.year, m: +p.month, d: +p.day };
    }

    const monthKey = (p = boardDate()) => `${p.y}-${pad2(p.m)}`;
    const dayKey = (p = boardDate()) => `${monthKey(p)}-${pad2(p.d)}`;

    function resetText() {
        const p = boardDate();
        const daysInMonth = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
        const left = daysInMonth - p.d + 1;
        return left <= 1 ? 'The board resets tonight at midnight.' : `The board resets in ${left} days.`;
    }

    // ---- Image helpers ----

    const webpSupported = (() => {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        return c.toDataURL('image/webp').startsWith('data:image/webp');
    })();

    function encodeCanvas(canvas) {
        return webpSupported ? canvas.toDataURL('image/webp', 0.86) : canvas.toDataURL('image/jpeg', 0.88);
    }

    function renderSquare(drawFn) {
        const size = CONFIG.imageSize;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        drawFn(ctx, size);
        return encodeCanvas(c);
    }

    // ---- Geometry ----

    function corners(n) {
        const h = N / 2;
        const r = (n.rot * Math.PI) / 180;
        const c = Math.cos(r);
        const s = Math.sin(r);
        return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => [n.x + x * c - y * s, n.y + x * s + y * c]);
    }

    // Separating-axis test for two rotated squares.
    function overlaps(a, b) {
        const pa = corners(a);
        const pb = corners(b);
        for (const poly of [pa, pb]) {
            for (let i = 0; i < 4; i++) {
                const [x1, y1] = poly[i];
                const [x2, y2] = poly[(i + 1) % 4];
                const ax = y1 - y2;
                const ay = x2 - x1;
                const project = (pts) => pts.map(([x, y]) => x * ax + y * ay);
                const A = project(pa);
                const B = project(pb);
                if (Math.max(...A) <= Math.min(...B) + 1e-6 || Math.max(...B) <= Math.min(...A) + 1e-6) return false;
            }
        }
        return true;
    }

    // ---- State ----

    const cloudConfig = window.STICKY_BOARD_CONFIG || {};
    const store = new window.CloudBoardStore(cloudConfig);
    const state = {
        month: monthKey(),
        deviceId: null,
        notes: [],
        active: null, // { kind: 'draft' | 'move', note }
        showGhost: false,
        origin: { x: 0, y: 0 },
        busy: false,
        available: false,
        loadError: '',
    };

    const viewport = $('sb-viewport');
    const world = $('sb-world');
    const notesLayer = $('sb-notes');
    const ghostLayer = $('sb-ghost-layer');
    const hub = $('sb-hub');
    const editbar = $('sb-editbar');
    const compactHub = $('sb-compact-hub');
    let hubInView = true;
    // Keep the main controls centered through late layout changes until the user moves the board.
    let pinnedCenter = true;
    let worldBounds = null;
    const els = new Map();

    const myNote = () => state.notes.find((n) => n.deviceId === state.deviceId) || null;

    function blockersOf(note) {
        return state.notes.filter((o) => o.id !== note.id && o.z > note.z && overlaps(note, o));
    }

    function displayNotes() {
        const a = state.active;
        const list = state.notes.map((n) => (a && a.kind === 'move' && n.id === a.note.id ? a.note : n));
        if (a && a.kind === 'draft') list.push(a.note);
        return list;
    }

    // ---- World sizing ----

    function toWorld(clientX, clientY) {
        const rect = world.getBoundingClientRect();
        return { x: clientX - rect.left - state.origin.x, y: clientY - rect.top - state.origin.y };
    }

    function updateWorld() {
        const r = N * Math.SQRT1_2 + 60; // rotated half-diagonal plus room for the rotate knob
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        const hw = hub.offsetWidth / 2 + 40;
        const hh = hub.offsetHeight / 2 + 40;
        let minX = Math.min(-vw / 2, -hw);
        let maxX = Math.max(vw / 2, hw);
        let minY = Math.min(-vh / 2, -hh);
        let maxY = Math.max(vh / 2, hh + 70);
        for (const n of displayNotes()) {
            minX = Math.min(minX, n.x - r - CONFIG.worldPad);
            maxX = Math.max(maxX, n.x + r + CONFIG.worldPad);
            minY = Math.min(minY, n.y - r - CONFIG.worldPad);
            maxY = Math.max(maxY, n.y + r + CONFIG.worldPad);
        }
        // Never shrink the world mid-edit: shrinking clamps the scroll position and yanks the view.
        if (state.active && worldBounds) {
            minX = Math.min(minX, worldBounds.minX);
            maxX = Math.max(maxX, worldBounds.maxX);
            minY = Math.min(minY, worldBounds.minY);
            maxY = Math.max(maxY, worldBounds.maxY);
        }
        worldBounds = { minX, maxX, minY, maxY };
        const origin = { x: Math.round(-minX), y: Math.round(-minY) };
        const dx = origin.x - state.origin.x;
        const dy = origin.y - state.origin.y;
        world.style.width = `${Math.round(maxX - minX)}px`;
        world.style.height = `${Math.round(maxY - minY)}px`;
        state.origin = origin;
        hub.style.left = `${origin.x}px`;
        hub.style.top = `${origin.y}px`;
        // Growing up/left shifts every coordinate; scroll by the same amount so nothing jumps.
        if (dx || dy) {
            for (const note of displayNotes()) {
                const el = els.get(note.id);
                if (el) placeEl(el, note);
            }
            const ghost = ghostLayer.querySelector('.sb-ghost');
            const mine = myNote();
            if (ghost && mine) placeEl(ghost, mine);
            viewport.scrollBy(dx, dy);
        }
        if (pinnedCenter && !state.active) centerView();
        return dx !== 0 || dy !== 0;
    }

    function unpinCenter() {
        pinnedCenter = false;
    }

    function centerView() {
        const panel = hub.querySelector('.sb-hub-main').getBoundingClientRect();
        const rect = viewport.getBoundingClientRect();
        viewport.scrollBy(
            panel.left + panel.width / 2 - rect.left - viewport.clientWidth / 2,
            panel.top + panel.height / 2 - rect.top - viewport.clientHeight / 2,
        );
    }

    function scrollToNote(note) {
        const de = viewport;
        const rect = world.getBoundingClientRect();
        const cx = rect.left + state.origin.x + note.x;
        const cy = rect.top + state.origin.y + note.y;
        // Only scroll when the note is meaningfully off-screen; small (mobile) viewports need a smaller margin.
        const mx = Math.min(N * 0.75, de.clientWidth / 4);
        const my = Math.min(N * 0.75, de.clientHeight / 4);
        if (cx > mx && cx < de.clientWidth - mx && cy > my && cy < de.clientHeight - my) return;
        unpinCenter();
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        viewport.scrollTo({
            left: state.origin.x + note.x - de.clientWidth / 2,
            top: state.origin.y + note.y - de.clientHeight / 2,
            behavior: reduce ? 'auto' : 'smooth',
        });
    }

    // ---- Rendering ----

    function buildNote(note) {
        const el = document.createElement('div');
        el.className = `sb-note sb-note--${note.type}`;
        el.dataset.id = note.id;
        const face = document.createElement('div');
        face.className = 'sb-note-face';
        if (note.type !== 'photo') face.style.backgroundColor = paperColor(note.paper);
        if (note.type === 'text') {
            const p = document.createElement('p');
            p.className = 'sb-note-text';
            const span = document.createElement('span');
            span.textContent = note.content;
            p.append(span);
            face.append(p);
            el.setAttribute('aria-label', `Note: ${note.content}`);
        } else {
            const img = new Image();
            img.alt = '';
            img.draggable = false;
            if (isSafeImage(note.content)) img.src = note.content;
            face.append(img);
            el.setAttribute('aria-label', note.type === 'draw' ? 'A drawing' : 'A photo');
        }
        el.append(face);
        el.setAttribute('role', 'img');
        el._label = el.getAttribute('aria-label');
        el._content = note.content;
        el._paper = note.paper;
        return el;
    }

    function fitText(el) {
        const p = el.querySelector('.sb-note-text');
        if (!p) return;
        const span = p.firstChild;
        let size = 34;
        span.style.fontSize = `${size}px`;
        while (size > 11 && span.offsetHeight > p.clientHeight) {
            size -= 1;
            span.style.fontSize = `${size}px`;
        }
    }

    function placeEl(el, note) {
        el.style.transform = `translate(${state.origin.x + note.x - N / 2}px, ${state.origin.y + note.y - N / 2}px) rotate(${note.rot}deg)`;
    }

    function renderNotes() {
        const mine = myNote();
        const activeId = state.active ? state.active.note.id : null;
        const seen = new Set();
        for (const note of displayNotes()) {
            let el = els.get(note.id);
            if (!el || el._content !== note.content || el._paper !== note.paper) {
                if (el) el.remove();
                el = buildNote(note);
                notesLayer.append(el);
                els.set(note.id, el);
                fitText(el);
            }
            seen.add(note.id);
            placeEl(el, note);
            const isActive = note.id === activeId;
            const isMine = !!mine && note.id === mine.id;
            el.style.zIndex = isActive ? ACTIVE_Z : note.z;
            el.classList.toggle('is-active', isActive);
            el.classList.toggle('is-mine', isMine && !state.active);
            if (isMine && !state.active) {
                el.setAttribute('role', 'button');
                el.tabIndex = 0;
                el.setAttribute('aria-label', 'Your note. Activate to move or rotate it.');
            } else if (el.getAttribute('role') === 'button') {
                el.setAttribute('role', 'img');
                el.setAttribute('aria-label', el._label);
                el.removeAttribute('tabindex');
            }
            let knob = el.querySelector('.sb-rotate');
            if (isActive && !knob) {
                knob = document.createElement('div');
                knob.className = 'sb-rotate';
                knob.setAttribute('aria-hidden', 'true');
                el.append(knob);
            } else if (!isActive && knob) {
                knob.remove();
            }
        }
        for (const [id, el] of els) {
            if (!seen.has(id)) {
                el.remove();
                els.delete(id);
            }
        }
    }

    function renderGhost() {
        ghostLayer.replaceChildren();
        const mine = myNote();
        if (!state.showGhost || !mine || state.active) return;
        const el = buildNote(mine);
        el.classList.add('sb-ghost');
        el.setAttribute('aria-hidden', 'true');
        el.style.zIndex = GHOST_Z;
        const label = document.createElement('span');
        label.className = 'sb-ghost-label';
        label.textContent = 'your note';
        el.append(label);
        placeEl(el, mine);
        ghostLayer.append(el);
        fitText(el);
    }

    function renderHub() {
        const mine = myNote();
        const drafting = state.active && state.active.kind === 'draft';
        const createBtn = $('sb-create-btn');
        const displayBtn = $('sb-display-btn');
        const bumpBtn = $('sb-bump-btn');
        const moveBtn = $('sb-move-btn');
        const status = $('sb-hub-status');
        const claimed = store.hasPosted && !mine;

        createBtn.hidden = !!mine;
        createBtn.disabled = drafting || state.busy || !state.available || claimed;
        createBtn.textContent = drafting ? 'Placing your note…' : 'Create note';
        displayBtn.hidden = !mine;
        bumpBtn.hidden = !mine;
        moveBtn.hidden = !mine;

        if (mine) {
            const blockers = blockersOf(mine);
            const bumpedToday = mine.bumpedOn === dayKey();
            displayBtn.textContent = state.showGhost ? 'Hide note' : 'Display note';
            displayBtn.setAttribute('aria-pressed', String(state.showGhost));
            displayBtn.disabled = !!state.active;
            moveBtn.disabled = !!state.active || state.busy;
            bumpBtn.disabled = !blockers.length || bumpedToday || !!state.active || state.busy;
            if (state.active) {
                status.textContent = 'Drag your note into place, then save.';
            } else if (!blockers.length) {
                status.textContent = 'Your note is on top. Nothing is covering it.';
            } else {
                const count = `${blockers.length} note${blockers.length > 1 ? 's are' : ' is'} covering yours.`;
                status.textContent = bumpedToday ? `${count} You've bumped today, so check back tomorrow.` : `${count} You can bump it to the top.`;
            }
        } else {
            status.textContent = !state.available
                ? state.loadError || 'Connecting to the shared board...'
                : claimed ? 'Your submission for this month has already been used.'
                : drafting ? 'Drag your note into place, then post it.' : '';
        }
        $('sb-reset').textContent = resetText();
        renderCompactHub();
    }

    function renderCompactHub() {
        compactHub.hidden = hubInView || !myNote() || !!state.active;
        compactHub.querySelectorAll('[data-hub-action]').forEach((button) => {
            const source = $(button.dataset.hubAction);
            button.textContent = source.textContent;
            button.disabled = source.disabled;
            if (source.hasAttribute('aria-pressed')) {
                button.setAttribute('aria-pressed', source.getAttribute('aria-pressed'));
            }
        });
    }

    function renderEditbar() {
        const a = state.active;
        editbar.hidden = !a;
        if (!a) return;
        $('sb-edit-content').hidden = a.kind !== 'draft';
        $('sb-edit-commit').textContent = a.kind === 'draft' ? 'Post note' : 'Save';
        editbar.querySelectorAll('button').forEach((b) => { b.disabled = state.busy; });
    }

    function renderAll() {
        updateWorld();
        renderNotes();
        renderGhost();
        renderHub();
        renderEditbar();
    }

    let toastTimer = 0;
    function toast(message) {
        const t = $('sb-toast');
        t.textContent = message;
        t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
    }

    let reloading = false;
    let reloadPending = false;
    async function reload() {
        if (reloading || drag) {
            reloadPending = true;
            return;
        }
        reloading = true;
        try {
            state.notes = await store.list(state.month);
            state.available = true;
            state.loadError = '';
            clockOffset = store.clockOffset;
            state.deviceId = store.identity.deviceId;
            if (state.month !== store.month) {
                state.active = null;
                state.showGhost = false;
                composer.reset();
            }
            state.month = store.month;
        } catch (err) {
            console.error(err);
            state.loadError = err.message || 'Could not load the board.';
            toast(err.message || 'Could not load the board.');
        } finally {
            reloading = false;
        }
        renderAll();
        if (reloadPending) {
            reloadPending = false;
            await reload();
        }
    }

    // ---- Placing / moving ----

    function beginDraft(content) {
        if (state.active && state.active.kind === 'draft') {
            Object.assign(state.active.note, content);
        } else {
            const de = viewport;
            const c = toWorld(de.clientWidth / 2, de.clientHeight / 2);
            let { x, y } = c;
            const hw = hub.offsetWidth / 2;
            const hh = hub.offsetHeight / 2;
            if (Math.abs(x) < hw + N / 2 && Math.abs(y) < hh + N / 2 + 70) {
                if (de.clientWidth >= 720) {
                    x = hw + N / 2 + 40;
                    y = 0;
                } else {
                    x = 0;
                    y = hh + N / 2 + 100;
                }
            }
            state.active = {
                kind: 'draft',
                note: { id: 'draft', deviceId: state.deviceId, ...content, x: Math.round(x), y: Math.round(y), rot: Math.round(Math.random() * 10 - 5), z: 0 },
            };
        }
        state.showGhost = false;
        unpinCenter();
        renderAll();
        scrollToNote(state.active.note);
        focusActive();
    }

    function beginMove({ scroll = true } = {}) {
        const mine = myNote();
        if (!mine || state.active) return;
        state.active = { kind: 'move', note: { ...mine } };
        state.showGhost = false;
        unpinCenter();
        renderAll();
        if (scroll) scrollToNote(mine);
        focusActive();
    }

    function focusActive() {
        const el = state.active && els.get(state.active.note.id);
        if (el) {
            el.tabIndex = -1;
            el.focus({ preventScroll: true });
        }
    }

    function cancelActive() {
        if (!state.active) return;
        state.active = null;
        renderAll();
        $('sb-create-btn').focus({ preventScroll: true });
    }

    async function commitActive() {
        const a = state.active;
        if (!a || state.busy) return;
        state.busy = true;
        renderEditbar();
        try {
            const { x, y, rot } = a.note;
            if (a.kind === 'draft') {
                const { type, content, paper } = a.note;
                await store.create(state.month, { deviceId: state.deviceId, type, content, paper, x, y, rot });
                composer.reset();
                toast('Posted! See you next month.');
            } else {
                await store.update(state.month, a.note.id, state.deviceId, { x, y, rot, version: a.note.version });
                toast('Note moved.');
            }
            state.active = null;
        } catch (err) {
            toast(err.message || 'Something went wrong. Try again.');
        } finally {
            state.busy = false;
        }
        await reload();
    }

    function nudgeActive(dx, dy, drot) {
        const n = state.active.note;
        n.x = clamp(n.x + dx, -CONFIG.worldLimit, CONFIG.worldLimit);
        n.y = clamp(n.y + dy, -CONFIG.worldLimit, CONFIG.worldLimit);
        n.rot = normDeg(n.rot + drot);
        updateWorld();
        renderNotes();
    }

    // ---- Pointer interactions ----

    let drag = null;

    function applyDrag() {
        const n = state.active.note;
        const wp = toWorld(drag.cx, drag.cy);
        if (drag.mode === 'move') {
            n.x = Math.round(clamp(wp.x + drag.offX, -CONFIG.worldLimit, CONFIG.worldLimit));
            n.y = Math.round(clamp(wp.y + drag.offY, -CONFIG.worldLimit, CONFIG.worldLimit));
        } else {
            let deg = (Math.atan2(wp.y - n.y, wp.x - n.x) * 180) / Math.PI + 90;
            if (drag.shift) deg = Math.round(deg / 15) * 15;
            n.rot = Math.round(normDeg(deg) * 10) / 10;
        }
        updateWorld();
        placeEl(els.get(n.id), n);
    }

    function autoScrollTick() {
        if (!drag || drag.mode !== 'move') return;
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        const edge = 32;
        const maxSpeed = 14;
        let dx = 0;
        let dy = 0;
        // Only scroll once the user is actually dragging, and only toward the side they're heading.
        if (drag.armed) {
            const box = drag.el.getBoundingClientRect();
            const vr = viewport.getBoundingClientRect();
            const o = drag.overhang;
            const depth = (fingerIn, noteOut) => Math.max(fingerIn, noteOut);
            const left = depth(edge - (drag.cx - vr.left), drag.dirX < 0 ? vr.left - box.left - o.left : -1);
            const right = depth(drag.cx - vr.left - (vw - edge), drag.dirX > 0 ? box.right - (vr.left + vw) - o.right : -1);
            const top = depth(edge - (drag.cy - vr.top), drag.dirY < 0 ? vr.top - box.top - o.top : -1);
            const bottom = depth(drag.cy - vr.top - (vh - edge), drag.dirY > 0 ? box.bottom - (vr.top + vh) - o.bottom : -1);
            const speed = (d) => Math.ceil(maxSpeed * Math.min(1, d / edge));
            if (left >= 0) dx = -speed(left + 1);
            else if (right >= 0) dx = speed(right + 1);
            if (top >= 0) dy = -speed(top + 1);
            else if (bottom >= 0) dy = speed(bottom + 1);
        }
        if (dx || dy) {
            viewport.scrollBy(dx, dy);
            applyDrag();
        }
        drag.raf = requestAnimationFrame(autoScrollTick);
    }

    function startDrag(e, noteEl) {
        const a = state.active;
        const wp = toWorld(e.clientX, e.clientY);
        // A note picked up while already hanging off-screen shouldn't scroll until it's pushed further out.
        const box = noteEl.getBoundingClientRect();
        const vr = viewport.getBoundingClientRect();
        const overhang = {
            left: Math.max(0, vr.left - box.left),
            right: Math.max(0, box.right - vr.left - viewport.clientWidth),
            top: Math.max(0, vr.top - box.top),
            bottom: Math.max(0, box.bottom - vr.top - viewport.clientHeight),
        };
        drag = {
            mode: e.target.closest('.sb-rotate') ? 'rotate' : 'move',
            pointerId: e.pointerId,
            overhang,
            sx: e.clientX,
            sy: e.clientY,
            cx: e.clientX,
            cy: e.clientY,
            dirX: 0,
            dirY: 0,
            armed: false,
            shift: e.shiftKey,
            offX: a.note.x - wp.x,
            offY: a.note.y - wp.y,
            el: noteEl,
        };
        noteEl.setPointerCapture(e.pointerId);
        noteEl.classList.add('is-dragging');
        drag.raf = requestAnimationFrame(autoScrollTick);
    }

    // Touch: press and hold your own note to pick it up and drag it in one gesture.
    let hold = null;
    function cancelHold() {
        if (!hold) return;
        clearTimeout(hold.timer);
        hold = null;
    }

    world.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const noteEl = e.target.closest('.sb-note');
        const a = state.active;
        if (a && noteEl && noteEl.dataset.id === a.note.id) {
            e.preventDefault();
            startDrag(e, noteEl);
            return;
        }
        const mine = myNote();
        if (!a && e.pointerType !== 'mouse' && noteEl && mine && noteEl.dataset.id === mine.id) {
            cancelHold();
            hold = {
                pointerId: e.pointerId,
                x: e.clientX,
                y: e.clientY,
                timer: setTimeout(() => {
                    const ev = { pointerId: hold.pointerId, clientX: hold.x, clientY: hold.y, shiftKey: false, target: noteEl };
                    hold = null;
                    beginMove({ scroll: false });
                    const el = els.get(mine.id);
                    if (!state.active || !el) return;
                    if (navigator.vibrate) navigator.vibrate(15);
                    try {
                        startDrag({ ...ev, target: el }, el);
                    } catch (err) {
                        drag = null; // pointer already released
                    }
                }, CONFIG.holdDelay),
            };
            return;
        }
        // Mouse users can grab empty board to pan; touch already scrolls natively.
        if (!noteEl && e.pointerType === 'mouse' && !e.target.closest('.sb-hub')) {
            e.preventDefault();
            drag = { mode: 'pan', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, x0: viewport.scrollLeft, y0: viewport.scrollTop };
            document.body.style.cursor = 'grabbing';
            unpinCenter();
        }
    });

    // Only real user gestures unpin the centered view; programmatic scrolls fire none of these.
    viewport.addEventListener('wheel', unpinCenter, { passive: true });
    viewport.addEventListener('touchmove', unpinCenter, { passive: true });
    viewport.addEventListener('pointerdown', (e) => {
        if (e.target === viewport) unpinCenter(); // scrollbar grab
    });
    document.addEventListener('keydown', (e) => {
        const scrollKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '];
        if (!scrollKeys.includes(e.key) || e.target.isContentEditable) return;
        if (e.key === ' ' && e.target.tagName === 'BUTTON') return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || document.querySelector('dialog[open]')) return;
        unpinCenter();
    }, true);

    window.addEventListener('pointermove', (e) => {
        if (hold && e.pointerId === hold.pointerId && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) cancelHold();
        if (!drag || e.pointerId !== drag.pointerId) return;
        if (drag.mode === 'pan') {
            viewport.scrollTo(drag.x0 - (e.clientX - drag.sx), drag.y0 - (e.clientY - drag.sy));
            return;
        }
        if (e.clientX !== drag.cx) drag.dirX = Math.sign(e.clientX - drag.cx);
        if (e.clientY !== drag.cy) drag.dirY = Math.sign(e.clientY - drag.cy);
        if (!drag.armed && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 8) drag.armed = true;
        drag.cx = e.clientX;
        drag.cy = e.clientY;
        drag.shift = e.shiftKey;
        applyDrag();
    });

    // A long-press pickup starts after the touch began, so block native panning while a note is held.
    document.addEventListener('touchmove', (e) => {
        if (drag && drag.mode !== 'pan' && e.cancelable) e.preventDefault();
    }, { passive: false });
    world.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.sb-note.is-mine, .sb-note.is-active')) e.preventDefault();
    });

    function endDrag(e) {
        if (hold && e.pointerId === hold.pointerId) cancelHold();
        if (!drag || e.pointerId !== drag.pointerId) return;
        cancelAnimationFrame(drag.raf);
        if (drag.el) drag.el.classList.remove('is-dragging');
        document.body.style.cursor = '';
        drag = null;
        if (reloadPending) {
            reloadPending = false;
            reload();
        }
    }
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    world.addEventListener('click', (e) => {
        const noteEl = e.target.closest('.sb-note');
        const mine = myNote();
        if (!state.active && noteEl && mine && noteEl.dataset.id === mine.id) beginMove();
    });

    world.addEventListener('keydown', (e) => {
        const noteEl = e.target.closest && e.target.closest('.sb-note.is-mine');
        if (!state.active && noteEl && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            e.stopPropagation();
            beginMove();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (!state.active || document.querySelector('dialog[open]')) return;
        const tag = e.target.tagName;
        const onButton = tag === 'BUTTON' || tag === 'INPUT';
        const step = e.shiftKey ? 50 : 10;
        const moves = { ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, -step, 0], ArrowDown: [0, step, 0], '[': [0, 0, -5], ']': [0, 0, 5] };
        if (moves[e.key] && !onButton) {
            e.preventDefault();
            nudgeActive(...moves[e.key]);
        } else if (e.key === 'Escape') {
            cancelActive();
        } else if (e.key === 'Enter' && !onButton) {
            e.preventDefault();
            commitActive();
        }
    });

    editbar.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (!act || !state.active) return;
        switch (act.dataset.act) {
            case 'rotl': nudgeActive(0, 0, -15); break;
            case 'rotr': nudgeActive(0, 0, 15); break;
            case 'edit': composer.open(); break;
            case 'cancel': cancelActive(); break;
            case 'commit': commitActive(); break;
            default: break;
        }
    });

    // ---- Hub buttons ----

    compactHub.addEventListener('click', (e) => {
        const button = e.target.closest('[data-hub-action]');
        if (button) $(button.dataset.hubAction).click();
    });

    $('sb-back').addEventListener('click', () => {
        if (window.history.length > 1) window.history.back();
        else window.location.href = CONFIG.fallbackBack;
    });

    $('sb-create-btn').addEventListener('click', () => {
        if (myNote()) return;
        composer.open();
    });

    $('sb-display-btn').addEventListener('click', () => {
        const mine = myNote();
        if (!mine) return;
        state.showGhost = !state.showGhost;
        renderGhost();
        renderHub();
        if (state.showGhost) scrollToNote(mine);
    });

    $('sb-move-btn').addEventListener('click', beginMove);

    $('sb-bump-btn').addEventListener('click', async () => {
        const mine = myNote();
        if (!mine || state.busy) return;
        state.busy = true;
        renderHub();
        try {
            await store.bump(state.month, mine.id, state.deviceId, mine.version);
            toast('Bumped to the top!');
        } catch (err) {
            toast(err.message);
        } finally {
            state.busy = false;
        }
        await reload();
        scrollToNote(myNote());
    });

    // ---- Dialog helpers ----

    document.querySelectorAll('dialog').forEach((dlg) => {
        dlg.addEventListener('click', (e) => {
            if (e.target.closest('[data-close]') || e.target === dlg) dlg.close();
        });
        dlg.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && dlg.open) {
                e.preventDefault();
                dlg.close();
            }
        });
    });

    $('sb-help-btn').addEventListener('click', () => {
        $('sb-help').showModal();
    });

    // ---- Composer (create dialog) ----

    const composer = (() => {
        const dlg = $('sb-create');
        const textEl = $('sb-text');
        const drawCanvas = $('sb-draw');
        const dctx = drawCanvas.getContext('2d', { willReadFrequently: true });
        const cropCanvas = $('sb-crop');
        const cctx = cropCanvas.getContext('2d');
        const errorEl = $('sb-create-error');
        const tabs = Array.from(dlg.querySelectorAll('[role="tab"]'));
        const S = drawCanvas.width;
        const C = cropCanvas.width;

        const st = { type: 'text', paper: 'yellow', ink: INKS[0].color, eraser: false, undo: [], photo: null };

        function makeSwatches(container, items, onPick, isSelected) {
            container.replaceChildren();
            for (const item of items) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'sb-swatch';
                b.style.background = item.color;
                b.setAttribute('aria-label', item.label);
                b.setAttribute('aria-pressed', String(isSelected(item)));
                b.addEventListener('click', () => {
                    onPick(item);
                    container.querySelectorAll('.sb-swatch').forEach((s, i) => s.setAttribute('aria-pressed', String(isSelected(items[i]))));
                });
                container.append(b);
            }
        }

        function applyPaper() {
            const color = paperColor(st.paper);
            textEl.style.background = color;
            drawCanvas.style.background = color;
        }

        makeSwatches($('sb-papers'), PAPERS, (p) => { st.paper = p.id; applyPaper(); }, (p) => p.id === st.paper);
        makeSwatches($('sb-inks'), INKS, (ink) => {
            st.ink = ink.color;
            st.eraser = false;
            $('sb-eraser').setAttribute('aria-pressed', 'false');
        }, (ink) => !st.eraser && ink.color === st.ink);

        function setTab(type, focus = false) {
            st.type = type;
            for (const t of tabs) {
                const on = t.dataset.type === type;
                t.setAttribute('aria-selected', String(on));
                t.tabIndex = on ? 0 : -1;
                if (on && focus) t.focus();
            }
            dlg.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== type; });
            $('sb-paper-row').hidden = type === 'photo';
            errorEl.textContent = '';
        }

        tabs.forEach((t, i) => {
            t.addEventListener('click', () => setTab(t.dataset.type));
            t.addEventListener('keydown', (e) => {
                const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                if (!dir) return;
                e.preventDefault();
                setTab(tabs[(i + dir + tabs.length) % tabs.length].dataset.type, true);
            });
        });

        // Text
        textEl.addEventListener('input', () => {
            $('sb-text-count').textContent = `${textEl.value.length} / ${CONFIG.textLimit}`;
        });

        // Drawing
        let drawing = null;
        const canvasPoint = (canvas, e) => {
            const r = canvas.getBoundingClientRect();
            return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
        };

        function strokeTo(p) {
            dctx.globalCompositeOperation = st.eraser ? 'destination-out' : 'source-over';
            dctx.strokeStyle = st.ink;
            dctx.lineWidth = +$('sb-brush').value;
            dctx.lineCap = 'round';
            dctx.lineJoin = 'round';
            const path = new Path2D();
            path.moveTo(drawing.x, drawing.y);
            path.lineTo(p.x, p.y);
            dctx.stroke(path);
            drawing = p;
        }

        drawCanvas.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            drawCanvas.setPointerCapture(e.pointerId);
            st.undo.push(dctx.getImageData(0, 0, S, S));
            if (st.undo.length > 20) st.undo.shift();
            drawing = canvasPoint(drawCanvas, e);
            strokeTo({ x: drawing.x + 0.01, y: drawing.y });
        });
        drawCanvas.addEventListener('pointermove', (e) => {
            if (!drawing) return;
            const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
            for (const ev of events.length ? events : [e]) strokeTo(canvasPoint(drawCanvas, ev));
        });
        const stopDrawing = () => { drawing = null; };
        drawCanvas.addEventListener('pointerup', stopDrawing);
        drawCanvas.addEventListener('pointercancel', stopDrawing);

        $('sb-eraser').addEventListener('click', (e) => {
            st.eraser = !st.eraser;
            e.currentTarget.setAttribute('aria-pressed', String(st.eraser));
            $('sb-inks').querySelectorAll('.sb-swatch').forEach((s, i) => s.setAttribute('aria-pressed', String(!st.eraser && INKS[i].color === st.ink)));
        });
        $('sb-undo').addEventListener('click', () => {
            const snap = st.undo.pop();
            if (snap) dctx.putImageData(snap, 0, 0);
        });
        $('sb-clear').addEventListener('click', () => {
            st.undo.push(dctx.getImageData(0, 0, S, S));
            dctx.clearRect(0, 0, S, S);
        });

        function drawingIsEmpty() {
            const data = dctx.getImageData(0, 0, S, S).data;
            for (let i = 3; i < data.length; i += 4) if (data[i]) return false;
            return true;
        }

        // Photo crop
        function drawCrop() {
            const ph = st.photo;
            cctx.clearRect(0, 0, C, C);
            if (ph) cctx.drawImage(ph.img, ph.ox, ph.oy, ph.img.naturalWidth * ph.scale, ph.img.naturalHeight * ph.scale);
        }

        function clampCrop() {
            const ph = st.photo;
            ph.ox = clamp(ph.ox, C - ph.img.naturalWidth * ph.scale, 0);
            ph.oy = clamp(ph.oy, C - ph.img.naturalHeight * ph.scale, 0);
        }

        function setZoom(z) {
            const ph = st.photo;
            if (!ph) return;
            const next = ph.min * z;
            ph.ox = C / 2 - ((C / 2 - ph.ox) * next) / ph.scale;
            ph.oy = C / 2 - ((C / 2 - ph.oy) * next) / ph.scale;
            ph.scale = next;
            clampCrop();
            drawCrop();
        }

        function showPhoto(has) {
            $('sb-photo-empty').hidden = has;
            cropCanvas.hidden = !has;
            $('sb-crop-tools').hidden = !has;
        }

        $('sb-photo-input').addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                errorEl.textContent = 'That file is not an image.';
                return;
            }
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const min = Math.max(C / img.naturalWidth, C / img.naturalHeight);
                st.photo = { img, min, scale: min, ox: (C - img.naturalWidth * min) / 2, oy: (C - img.naturalHeight * min) / 2 };
                $('sb-zoom').value = '1';
                errorEl.textContent = '';
                showPhoto(true);
                drawCrop();
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                errorEl.textContent = 'Your browser could not open that image. Try a JPEG or PNG.';
            };
            img.src = url;
        });

        $('sb-photo-change').addEventListener('click', () => $('sb-photo-input').click());
        $('sb-zoom').addEventListener('input', (e) => setZoom(+e.target.value));

        let panning = null;
        cropCanvas.addEventListener('pointerdown', (e) => {
            if (!st.photo) return;
            e.preventDefault();
            cropCanvas.setPointerCapture(e.pointerId);
            panning = canvasPoint(cropCanvas, e);
        });
        cropCanvas.addEventListener('pointermove', (e) => {
            if (!panning) return;
            const p = canvasPoint(cropCanvas, e);
            st.photo.ox += p.x - panning.x;
            st.photo.oy += p.y - panning.y;
            panning = p;
            clampCrop();
            drawCrop();
        });
        const stopPan = () => { panning = null; };
        cropCanvas.addEventListener('pointerup', stopPan);
        cropCanvas.addEventListener('pointercancel', stopPan);
        cropCanvas.addEventListener('wheel', (e) => {
            if (!st.photo) return;
            e.preventDefault();
            const zoom = $('sb-zoom');
            zoom.value = String(clamp(+zoom.value - e.deltaY * 0.002, 1, 4));
            setZoom(+zoom.value);
        }, { passive: false });

        // Output
        function build() {
            if (st.type === 'text') {
                const text = textEl.value.trim();
                if (!text) throw new Error('Write something first.');
                return { type: 'text', content: text.slice(0, CONFIG.textLimit), paper: st.paper };
            }
            if (st.type === 'draw') {
                if (drawingIsEmpty()) throw new Error('Draw something first.');
                const content = renderSquare((ctx, size) => {
                    ctx.fillStyle = paperColor(st.paper);
                    ctx.fillRect(0, 0, size, size);
                    ctx.drawImage(drawCanvas, 0, 0, size, size);
                });
                return { type: 'draw', content, paper: st.paper };
            }
            if (!st.photo) throw new Error('Choose a photo first.');
            const content = renderSquare((ctx, size) => ctx.drawImage(cropCanvas, 0, 0, size, size));
            return { type: 'photo', content, paper: 'cream' };
        }

        $('sb-place').addEventListener('click', () => {
            try {
                const note = build();
                dlg.close();
                beginDraft(note);
            } catch (err) {
                errorEl.textContent = err.message;
            }
        });

        applyPaper();

        return {
            open() {
                errorEl.textContent = '';
                setTab(st.type);
                dlg.showModal();
            },
            reset() {
                textEl.value = '';
                $('sb-text-count').textContent = `0 / ${CONFIG.textLimit}`;
                dctx.clearRect(0, 0, S, S);
                st.undo = [];
                st.photo = null;
                showPhoto(false);
                drawCrop();
            },
        };
    })();

    // ---- Boot ----

    async function init() {
        if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
        renderHub();
        updateWorld();
        centerView();
        $('sb-loading').hidden = false;
        viewport.setAttribute('aria-busy', 'true');
        try {
            state.notes = await store.list(state.month);
            state.available = true;
            state.loadError = '';
            clockOffset = store.clockOffset;
            state.deviceId = store.identity.deviceId;
            state.month = store.month;
        } catch (err) {
            console.error(err);
            state.loadError = err.message || 'Could not load the board.';
            toast(err.message || 'Could not load the board.');
        }
        renderAll();

        if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
            els.forEach(fitText);
            renderGhost();
        }
        updateWorld();
        centerView();
        $('sb-loading').hidden = true;
        viewport.setAttribute('aria-busy', 'false');

        if (cloudConfig.apiUrl) store.subscribe(() => reload());
        window.addEventListener('sticky-board-sync-error', () => {
            toast('Live updates interrupted. Reconnecting to the shared board.');
        });
        window.addEventListener('resize', () => updateWorld());
        new ResizeObserver(() => updateWorld()).observe(viewport);
        new ResizeObserver(() => updateWorld()).observe(hub);
        new IntersectionObserver(([entry]) => {
            hubInView = entry.isIntersecting;
            renderCompactHub();
        }, { root: viewport }).observe(hub.querySelector('.sb-hub-main'));

        setInterval(renderHub, 30000);
    }

    init();
})();
