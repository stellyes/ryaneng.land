(() => {
    'use strict';

    const CONFIG = {
        noteSize: 200,
        textLimit: 256,
        timeZone: 'America/Los_Angeles',
        worldLimit: 4000,
        worldPad: 120,
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
    const DEVICE_KEY = 'sticky-board:device';

    const $ = (id) => document.getElementById(id);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const pad2 = (n) => String(n).padStart(2, '0');
    const paperColor = (id) => (PAPERS.find((p) => p.id === id) || PAPERS[0]).color;
    const isSafeImage = (src) => typeof src === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(src);
    const normDeg = (d) => Math.round(((((d + 180) % 360) + 360) % 360 - 180) * 10) / 10;

    function uid() {
        const bytes = new Uint8Array(12);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    const storage = {
        get(key) {
            try { return localStorage.getItem(key); } catch { return null; }
        },
        set(key, value) {
            localStorage.setItem(key, value);
        },
        remove(key) {
            try { localStorage.removeItem(key); } catch { /* ignore */ }
        },
        keys() {
            try { return Object.keys(localStorage); } catch { return []; }
        },
    };

    // ---- Board time (one shared timezone so everyone resets together) ----

    const dateFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: CONFIG.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });

    function boardDate(date = new Date()) {
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

    function getDeviceId(regenerate = false) {
        let id = regenerate ? null : storage.get(DEVICE_KEY);
        if (!id) {
            id = uid();
            try { storage.set(DEVICE_KEY, id); } catch { /* private mode: id lives for this visit */ }
        }
        return id;
    }

    // ---- Storage ----
    //
    // Any store must implement:
    //   list(month)                          -> Promise<Note[]>
    //   create(month, {deviceId, type, content, paper, x, y, rot}) -> Promise<Note>
    //   update(month, id, deviceId, {x, y, rot})                   -> Promise<Note>
    //   bump(month, id, deviceId)            -> Promise<Note>
    //   subscribe(fn)                        -> called when the board changes elsewhere
    // A real shared store must enforce the same rules server-side (one note per
    // device per month, owner-only edits, one bump per day, monthly reset).

    class BoardError extends Error {}

    class LocalDemoStore {
        constructor() {
            this.isDemo = true;
            this.prefix = 'sticky-board:v1:';
            this.listeners = new Set();
            window.addEventListener('storage', (e) => {
                if (e.key && e.key.startsWith(this.prefix)) this.listeners.forEach((fn) => fn());
            });
        }

        key(month) { return this.prefix + month; }

        read(month) {
            try { return JSON.parse(storage.get(this.key(month))); } catch { return null; }
        }

        write(month, notes) {
            try {
                storage.set(this.key(month), JSON.stringify(notes));
            } catch {
                throw new BoardError('The demo board is out of browser storage. Try "Wipe this month\'s board".');
            }
        }

        purgeOldMonths(month) {
            for (const k of storage.keys()) {
                if (k.startsWith(this.prefix) && k !== this.key(month)) storage.remove(k);
            }
        }

        async list(month) {
            this.purgeOldMonths(month);
            let notes = this.read(month);
            if (!Array.isArray(notes)) {
                notes = makeSeedNotes();
                this.write(month, notes);
            }
            return notes;
        }

        async create(month, data) {
            const notes = await this.list(month);
            if (notes.some((n) => n.deviceId === data.deviceId)) {
                throw new BoardError('This device has already posted a note this month.');
            }
            if (data.type === 'text' && (!data.content.trim() || data.content.length > CONFIG.textLimit)) {
                throw new BoardError('Text notes need 1 to 256 characters.');
            }
            const note = {
                id: uid(),
                deviceId: data.deviceId,
                type: data.type,
                content: data.content,
                paper: data.paper,
                x: clamp(data.x, -CONFIG.worldLimit, CONFIG.worldLimit),
                y: clamp(data.y, -CONFIG.worldLimit, CONFIG.worldLimit),
                rot: normDeg(data.rot),
                z: maxZ(notes) + 1,
                createdAt: Date.now(),
                bumpedOn: dayKey(),
            };
            notes.push(note);
            this.write(month, notes);
            return note;
        }

        async update(month, id, deviceId, patch) {
            const notes = await this.list(month);
            const note = notes.find((n) => n.id === id);
            if (!note || note.deviceId !== deviceId) throw new BoardError('You can only move your own note.');
            note.x = clamp(patch.x, -CONFIG.worldLimit, CONFIG.worldLimit);
            note.y = clamp(patch.y, -CONFIG.worldLimit, CONFIG.worldLimit);
            note.rot = normDeg(patch.rot);
            this.write(month, notes);
            return note;
        }

        async bump(month, id, deviceId) {
            const notes = await this.list(month);
            const note = notes.find((n) => n.id === id);
            if (!note || note.deviceId !== deviceId) throw new BoardError('You can only bump your own note.');
            if (note.bumpedOn === dayKey()) throw new BoardError('You already bumped today. Come back tomorrow.');
            note.z = maxZ(notes) + 1;
            note.bumpedOn = dayKey();
            this.write(month, notes);
            return note;
        }

        subscribe(fn) { this.listeners.add(fn); }

        // Demo-only helpers
        async debugPatch(month, id, patch) {
            const notes = await this.list(month);
            const note = notes.find((n) => n.id === id);
            if (note) Object.assign(note, patch);
            this.write(month, notes);
        }

        async debugAdd(month, note) {
            const notes = await this.list(month);
            notes.push({ ...note, id: uid(), z: maxZ(notes) + 1, createdAt: Date.now(), bumpedOn: '' });
            this.write(month, notes);
        }

        async debugWipe(month) {
            storage.remove(this.key(month));
        }
    }

    const maxZ = (notes) => notes.reduce((m, n) => Math.max(m, n.z || 0), 0);

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

    function makeSeedNotes() {
        const sun = renderSquare((x, S) => {
            x.fillStyle = paperColor('yellow');
            x.fillRect(0, 0, S, S);
            x.strokeStyle = '#c0392b';
            x.lineWidth = 14;
            const path = new Path2D();
            path.arc(S / 2, S / 2, S * 0.18, 0, Math.PI * 2);
            for (let i = 0; i < 12; i++) {
                const a = (i * Math.PI) / 6;
                path.moveTo(S / 2 + Math.cos(a) * S * 0.26, S / 2 + Math.sin(a) * S * 0.26);
                path.lineTo(S / 2 + Math.cos(a) * S * 0.38, S / 2 + Math.sin(a) * S * 0.38);
            }
            x.stroke(path);
        });
        const heart = renderSquare((x, S) => {
            x.fillStyle = paperColor('pink');
            x.fillRect(0, 0, S, S);
            x.strokeStyle = '#2b2a22';
            x.lineWidth = 12;
            const path = new Path2D();
            path.moveTo(S * 0.5, S * 0.78);
            path.bezierCurveTo(S * 0.1, S * 0.5, S * 0.2, S * 0.18, S * 0.5, S * 0.36);
            path.bezierCurveTo(S * 0.8, S * 0.18, S * 0.9, S * 0.5, S * 0.5, S * 0.78);
            x.stroke(path);
        });
        const photo = renderSquare((x, S) => {
            const sky = x.createLinearGradient(0, 0, 0, S);
            sky.addColorStop(0, '#f6a35b');
            sky.addColorStop(0.6, '#f6d38b');
            x.fillStyle = sky;
            x.fillRect(0, 0, S, S);
            const sunPath = new Path2D();
            sunPath.arc(S * 0.62, S * 0.55, S * 0.12, 0, Math.PI * 2);
            x.fillStyle = '#fff3c4';
            x.fill(sunPath);
            const hills = new Path2D();
            hills.moveTo(0, S * 0.7);
            hills.quadraticCurveTo(S * 0.3, S * 0.5, S * 0.6, S * 0.72);
            hills.quadraticCurveTo(S * 0.85, S * 0.62, S, S * 0.7);
            hills.lineTo(S, S);
            hills.lineTo(0, S);
            hills.closePath();
            x.fillStyle = '#2f5a2a';
            x.fill(hills);
        });

        return [
            { type: 'text', paper: 'yellow', content: 'first!! (probably)', x: -430, y: -230, rot: -7 },
            { type: 'draw', paper: 'yellow', content: sun, x: -310, y: -150, rot: 6 },
            { type: 'text', paper: 'green', content: 'the moss is listening. say something nice.', x: 400, y: -240, rot: 4 },
            { type: 'photo', paper: 'cream', content: photo, x: 470, y: 120, rot: -4 },
            { type: 'text', paper: 'blue', content: 'who nailed that box to the middle of the board?', x: -470, y: 210, rot: 3 },
            { type: 'draw', paper: 'pink', content: heart, x: 130, y: 360, rot: -9 },
            { type: 'text', paper: 'cream', content: 'october again. leaves everywhere. i hope you are doing okay, whoever you are.', x: -60, y: -400, rot: 2 },
        ].map((n, i) => ({
            ...n,
            id: `seed-${i}`,
            deviceId: `seed-device-${i}`,
            z: i + 1,
            createdAt: Date.now(),
            bumpedOn: '',
        }));
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

    const store = new LocalDemoStore();
    const state = {
        month: monthKey(),
        deviceId: getDeviceId(),
        notes: [],
        active: null, // { kind: 'draft' | 'move', note }
        showGhost: false,
        origin: { x: 0, y: 0 },
        busy: false,
    };

    const world = $('sb-world');
    const notesLayer = $('sb-notes');
    const ghostLayer = $('sb-ghost-layer');
    const hub = $('sb-hub');
    const editbar = $('sb-editbar');
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
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
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
        const origin = { x: Math.round(-minX), y: Math.round(-minY) };
        const dx = origin.x - state.origin.x;
        const dy = origin.y - state.origin.y;
        world.style.width = `${Math.round(maxX - minX)}px`;
        world.style.height = `${Math.round(maxY - minY)}px`;
        state.origin = origin;
        hub.style.left = `${origin.x}px`;
        hub.style.top = `${origin.y}px`;
        // Growing up/left shifts every coordinate; scroll by the same amount so nothing jumps.
        if (dx || dy) window.scrollBy(dx, dy);
        return dx !== 0 || dy !== 0;
    }

    function centerView() {
        const de = document.documentElement;
        window.scrollTo(state.origin.x - de.clientWidth / 2, state.origin.y - de.clientHeight / 2);
    }

    function scrollToNote(note) {
        const de = document.documentElement;
        const rect = world.getBoundingClientRect();
        const cx = rect.left + state.origin.x + note.x;
        const cy = rect.top + state.origin.y + note.y;
        const m = N * 0.75;
        if (cx > m && cx < de.clientWidth - m && cy > m && cy < de.clientHeight - m) return;
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({
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

        createBtn.hidden = !!mine;
        createBtn.disabled = drafting || state.busy;
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
            status.textContent = drafting ? 'Drag your note into place, then post it.' : '';
        }
        $('sb-reset').textContent = resetText();
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

    async function reload() {
        try {
            state.notes = await store.list(state.month);
        } catch (err) {
            console.error(err);
            toast(err.message || 'Could not load the board.');
        }
        renderAll();
    }

    // ---- Placing / moving ----

    function beginDraft(content) {
        if (state.active && state.active.kind === 'draft') {
            Object.assign(state.active.note, content);
        } else {
            const de = document.documentElement;
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
        renderAll();
        scrollToNote(state.active.note);
        focusActive();
    }

    function beginMove() {
        const mine = myNote();
        if (!mine || state.active) return;
        state.active = { kind: 'move', note: { ...mine } };
        state.showGhost = false;
        renderAll();
        scrollToNote(mine);
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
                await store.update(state.month, a.note.id, state.deviceId, { x, y, rot });
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
        const de = document.documentElement;
        const edge = 48;
        const speed = 14;
        let dx = 0;
        let dy = 0;
        if (drag.cx < edge) dx = -speed;
        else if (drag.cx > de.clientWidth - edge) dx = speed;
        if (drag.cy < edge) dy = -speed;
        else if (drag.cy > de.clientHeight - edge) dy = speed;
        if (dx || dy) {
            window.scrollBy(dx, dy);
            applyDrag();
        }
        drag.raf = requestAnimationFrame(autoScrollTick);
    }

    world.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const noteEl = e.target.closest('.sb-note');
        const a = state.active;
        if (a && noteEl && noteEl.dataset.id === a.note.id) {
            e.preventDefault();
            const wp = toWorld(e.clientX, e.clientY);
            drag = {
                mode: e.target.closest('.sb-rotate') ? 'rotate' : 'move',
                pointerId: e.pointerId,
                cx: e.clientX,
                cy: e.clientY,
                shift: e.shiftKey,
                offX: a.note.x - wp.x,
                offY: a.note.y - wp.y,
                el: noteEl,
            };
            noteEl.setPointerCapture(e.pointerId);
            noteEl.classList.add('is-dragging');
            drag.raf = requestAnimationFrame(autoScrollTick);
            return;
        }
        // Mouse users can grab empty board to pan; touch already scrolls natively.
        if (!noteEl && e.pointerType === 'mouse' && !e.target.closest('.sb-hub')) {
            e.preventDefault();
            drag = { mode: 'pan', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, x0: window.scrollX, y0: window.scrollY };
            document.body.style.cursor = 'grabbing';
        }
    });

    window.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        if (drag.mode === 'pan') {
            window.scrollTo(drag.x0 - (e.clientX - drag.sx), drag.y0 - (e.clientY - drag.sy));
            return;
        }
        drag.cx = e.clientX;
        drag.cy = e.clientY;
        drag.shift = e.shiftKey;
        applyDrag();
    });

    function endDrag(e) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        cancelAnimationFrame(drag.raf);
        if (drag.el) drag.el.classList.remove('is-dragging');
        document.body.style.cursor = '';
        drag = null;
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
            await store.bump(state.month, mine.id, state.deviceId);
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
        $('sb-demo-tools').hidden = !store.isDemo;
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

    // ---- Demo tools ----

    $('sb-demo-tools').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-demo]');
        if (!btn) return;
        const mine = myNote();
        switch (btn.dataset.demo) {
            case 'cover':
                if (!mine) return toast('Post a note first.');
                await store.debugAdd(state.month, {
                    deviceId: `stranger-${uid()}`,
                    type: 'text',
                    paper: PAPERS[Math.floor(Math.random() * PAPERS.length)].id,
                    content: 'sorry, was this spot taken?',
                    x: mine.x + 60,
                    y: mine.y + 40,
                    rot: Math.round(Math.random() * 16 - 8),
                });
                toast('A stranger pinned a note on top of yours.');
                break;
            case 'tomorrow':
                if (!mine) return toast('Post a note first.');
                await store.debugPatch(state.month, mine.id, { bumpedOn: '' });
                toast("It's tomorrow (sort of). You can bump again.");
                break;
            case 'device':
                state.deviceId = getDeviceId(true);
                state.active = null;
                state.showGhost = false;
                toast('You are now a brand-new device.');
                break;
            case 'wipe':
                await store.debugWipe(state.month);
                state.active = null;
                state.showGhost = false;
                toast('Board wiped.');
                break;
            default:
                return;
        }
        $('sb-help').close();
        await reload();
    });

    // ---- Boot ----

    async function init() {
        if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
        try {
            state.notes = await store.list(state.month);
        } catch (err) {
            console.error(err);
            toast(err.message || 'Could not load the board.');
        }
        renderAll();
        centerView();

        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => {
                els.forEach(fitText);
                renderGhost();
            });
        }

        store.subscribe(() => { if (!drag) reload(); });
        window.addEventListener('resize', () => updateWorld());

        // Watch for midnight: new day re-enables bumping, a new month wipes the board.
        setInterval(() => {
            const month = monthKey();
            if (month !== state.month) {
                state.month = month;
                state.active = null;
                state.showGhost = false;
                composer.reset();
                toast('A new month! The board has been wiped clean.');
                reload();
            } else {
                renderHub();
            }
        }, 30000);
    }

    init();
})();
